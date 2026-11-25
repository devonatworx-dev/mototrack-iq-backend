import { Router } from 'express';
import jwt from 'jsonwebtoken';
import config from '../lib/config.js';
import {
  buildAuthorizeUrl,
  callbackUrl,
  clientCredentials,
  createPkce,
  exchangeCode,
  isFacebookEnabled,
  listProviders,
  providerConfig,
  randomState,
} from '../lib/oauth.js';
import { settleOAuthAccount } from '../lib/oauth-account.js';
import { getRiderById } from '../lib/db.js';
import {
  saveOAuthCode,
  saveOAuthState,
  takeOAuthCode,
  takeOAuthState,
} from '../lib/oauth-handoff.js';
import { rateLimit } from '../lib/rate-limit.js';
import { turnstilePublicConfig } from '../lib/turnstile.js';

const router = Router();
const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;

// Separate from the email-login limit (default 8). Anonymous /start and
// /callback were an unauthenticated write; the handoff is in memory now,
// and this cap stops one client from filling that map.
function oauthBrowserLimit(name) {
  return rateLimit({
    name,
    windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
    max: Number(process.env.OAUTH_RATE_LIMIT_MAX || 30),
  });
}
const limitStart = oauthBrowserLimit('oauth-start');
const limitCallback = oauthBrowserLimit('oauth-callback');

function signToken(riderId) {
  return jwt.sign({ riderId }, config.jwtSecret, { expiresIn: '30d' });
}

function sanitize(rider) {
  const { passwordHash, verifyToken, verifyTokenExpiry, resetToken, resetTokenExpiry, ...safe } = rider;
  return safe;
}

function publicOrigin(req) {
  const configured = (process.env.API_PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || 'https://mototrackiq.com').replace(/\/+$/, '');
}

function redirectToApp(res, params) {
  const url = new URL(`${frontendUrl()}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return res.redirect(url.toString());
}

router.get('/providers', (_req, res) => {
  res.json({
    providers: listProviders(),
    facebookEnabled: isFacebookEnabled(),
    phase: isFacebookEnabled() ? 2 : 1,
    turnstile: turnstilePublicConfig(),
  });
});

router.get('/:provider/start', limitStart, (req, res) => {
  const provider = req.params.provider;
  if (!listProviders().includes(provider)) {
    return res.status(404).json({
      error: 'That sign-in provider is not enabled.',
      code: 'provider_disabled',
    });
  }
  const { clientId } = clientCredentials(provider);
  if (!clientId) {
    return res.status(503).json({
      error: `${providerConfig(provider).label} sign-in is not configured yet.`,
      code: 'oauth_not_configured',
    });
  }
  const { verifier, challenge } = createPkce();
  const state = randomState();
  saveOAuthState({
    state,
    provider,
    verifier: providerConfig(provider).pkce ? verifier : '',
    // consent=1 is the optional marketing checkbox (portal sends it only when
    // that box is checked). It is not Terms acceptance and not required.
    consent: req.query.consent === '1' || req.query.consent === 'true' || req.query.marketingConsent === '1' || req.query.marketingConsent === 'true',
    ontario: req.query.ontario === '1',
    expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  const url = buildAuthorizeUrl({
    provider,
    clientId,
    redirectUri: callbackUrl(publicOrigin(req), provider),
    state,
    codeChallenge: challenge,
  });
  res.redirect(url);
});

router.get('/:provider/callback', limitCallback, async (req, res) => {
  const provider = req.params.provider;
  if (!listProviders().includes(provider)) {
    return redirectToApp(res, { oauth_error: 'provider_disabled', login: '1' });
  }
  if (req.query.error) {
    takeOAuthState(String(req.query.state || ''));
    const code = req.query.error === 'access_denied' ? 'access_denied' : 'oauth_failed';
    return redirectToApp(res, { oauth_error: code, login: '1' });
  }
  const saved = takeOAuthState(String(req.query.state || ''));
  if (!saved || saved.provider !== provider || !req.query.code) {
    return redirectToApp(res, { oauth_error: 'oauth_failed', login: '1' });
  }
  try {
    const profile = await exchangeCode({
      provider,
      code: String(req.query.code),
      verifier: saved.verifier,
      redirectUri: callbackUrl(publicOrigin(req), provider),
    });
    const settled = settleOAuthAccount(profile, {
      consent: Number(saved.consent) === 1,
      ontario: Number(saved.ontario) === 1,
    });
    if (settled.error) {
      return redirectToApp(res, { oauth_error: settled.error, login: '1' });
    }
    const code = randomState();
    saveOAuthCode({
      code,
      riderId: settled.rider.id,
      isNew: settled.isNew,
      expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    });
    return redirectToApp(res, { oauth_code: code });
  } catch (err) {
    console.error('[oauth]', provider, err.message);
    return redirectToApp(res, { oauth_error: err.code || 'oauth_failed', login: '1' });
  }
});

router.post('/exchange', (req, res) => {
  const code = String(req.body?.code || '');
  const row = code ? takeOAuthCode(code) : null;
  if (!row) {
    return res.status(400).json({ error: 'This sign-in link has expired. Try the provider again.', code: 'code_expired' });
  }
  const rider = getRiderById(row.rider_id);
  if (!rider) return res.status(404).json({ error: 'Account not found', code: 'no_rider' });
  res.json({
    success: true,
    token: signToken(rider.id),
    rider: sanitize(rider),
    isNew: Number(row.is_new) === 1,
  });
});

export default router;
