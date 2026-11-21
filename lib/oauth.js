import { createHash, randomBytes } from 'node:crypto';

/**
 * Direct OAuth 2.0 / OIDC for the existing rider JWT.
 *
 * Google and Microsoft are phase 1. Facebook is implemented and stays off
 * until FACEBOOK_OAUTH_ENABLED is true, which is after Meta approves the
 * email permission. These client ids are NOT the Gmail API client
 * (GOOGLE_CLIENT_ID in lib/email.js). Sign-in uses GOOGLE_OAUTH_CLIENT_ID.
 */

export const OAUTH_PROVIDERS = {
  google: {
    label: 'Google',
    phase: 1,
    pkce: true,
    scopeJoin: ' ',
    scopes: ['openid', 'email', 'profile'],
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
  },
  microsoft: {
    label: 'Microsoft',
    phase: 1,
    pkce: true,
    scopeJoin: ' ',
    scopes: ['openid', 'profile', 'email'],
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfo: 'https://graph.microsoft.com/oidc/userinfo',
    clientIdEnv: 'MICROSOFT_OAUTH_CLIENT_ID',
    clientSecretEnv: 'MICROSOFT_OAUTH_CLIENT_SECRET',
  },
  facebook: {
    label: 'Facebook',
    phase: 2,
    pkce: false,
    scopeJoin: ',',
    scopes: ['email', 'public_profile'],
    authorize: 'https://www.facebook.com/v21.0/dialog/oauth',
    token: 'https://graph.facebook.com/v21.0/oauth/access_token',
    userinfo: 'https://graph.facebook.com/v21.0/me',
    clientIdEnv: 'FACEBOOK_OAUTH_CLIENT_ID',
    clientSecretEnv: 'FACEBOOK_OAUTH_CLIENT_SECRET',
  },
};

export function isFacebookEnabled(env = process.env) {
  const value = String(env.FACEBOOK_OAUTH_ENABLED || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function listProviders(env = process.env) {
  const providers = ['google', 'microsoft'];
  if (isFacebookEnabled(env)) providers.push('facebook');
  return providers;
}

export function providerConfig(name) {
  return OAUTH_PROVIDERS[name] || null;
}

export function clientCredentials(name, env = process.env) {
  const spec = providerConfig(name);
  if (!spec) return { clientId: '', clientSecret: '' };
  return {
    clientId: (env[spec.clientIdEnv] || '').trim(),
    clientSecret: (env[spec.clientSecretEnv] || '').trim(),
  };
}

export function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function randomState() {
  return randomBytes(32).toString('base64url');
}

export function callbackUrl(publicOrigin, provider) {
  return `${String(publicOrigin).replace(/\/+$/, '')}/api/auth/oauth/${provider}/callback`;
}

export function buildAuthorizeUrl({ provider, clientId, redirectUri, state, codeChallenge }) {
  const spec = providerConfig(provider);
  if (!spec) throw new Error(`Unknown provider ${provider}`);
  const url = new URL(spec.authorize);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', spec.scopes.join(spec.scopeJoin));
  url.searchParams.set('state', state);
  if (spec.pkce) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (provider === 'google') {
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    url.searchParams.set('include_granted_scopes', 'true');
  }
  if (provider === 'microsoft') {
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('prompt', 'select_account');
  }
  return url.toString();
}

function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function looksLikeEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || ''));
}

function flagTrue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function profileFromProvider(provider, raw) {
  if (provider === 'facebook') {
    const email = normEmail(raw.email);
    return {
      provider,
      providerUserId: String(raw.id || ''),
      email,
      // Facebook only returns an email after the user grants the email
      // permission, and that address is verified on their side.
      emailVerified: Boolean(email),
      firstName: String(raw.first_name || '').trim(),
      lastName: String(raw.last_name || '').trim(),
    };
  }
  const verified = flagTrue(raw.email_verified);
  let email = normEmail(raw.email);
  if (!email && verified && looksLikeEmail(raw.preferred_username)) {
    email = normEmail(raw.preferred_username);
  }
  return {
    provider,
    providerUserId: String(raw.sub || ''),
    email,
    emailVerified: Boolean(email) && verified,
    ...nameParts(raw),
  };
}

// Personal Microsoft accounts often omit given_name/family_name and only send
// a display "name", so fall back to splitting that.
export function nameParts(raw = {}) {
  let firstName = String(raw.given_name || raw.first_name || '').trim();
  let lastName = String(raw.family_name || raw.last_name || '').trim();
  if (!firstName && !lastName) {
    const full = String(raw.name || '').trim();
    if (full && !looksLikeEmail(full)) {
      const bits = full.split(/\s+/);
      firstName = bits.shift() || '';
      lastName = bits.join(' ');
    }
  }
  return { firstName, lastName };
}


// Microsoft's userinfo endpoint never returns email_verified, so the
// verification signal has to come from the id_token, which arrives directly
// from Microsoft's token endpoint over TLS (OIDC Core 3.1.3.7 lets a
// confidential client trust it without re-checking the signature).
// - Personal Microsoft accounts (consumers tenant): the email is the account's
//   own sign-in address, which Microsoft verified at account creation.
// - Work/school accounts: trusted only when the optional claim xms_edov
//   (email domain owner verified) is true. Add it in Entra under
//   Token configuration -> Add optional claim -> ID -> xms_edov.
export const MS_CONSUMERS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

export function microsoftEmailVerified(idClaims, { clientId, sub } = {}) {
  if (!idClaims) return { verified: false, email: '' };
  if (clientId && idClaims.aud !== clientId) return { verified: false, email: '' };
  if (sub && idClaims.sub && idClaims.sub !== sub) return { verified: false, email: '' };
  const email = normEmail(idClaims.email);
  const personal = idClaims.tid === MS_CONSUMERS_TENANT;
  const verified = Boolean(email) && (personal || flagTrue(idClaims.xms_edov));
  return { verified, email };
}

export async function exchangeCode({
  provider, code, verifier, redirectUri, env = process.env, fetchImpl = fetch,
}) {
  const spec = providerConfig(provider);
  const { clientId, clientSecret } = clientCredentials(provider, env);
  if (!clientId || !clientSecret) {
    const err = new Error(`${spec.label} OAuth client is not configured`);
    err.code = 'oauth_not_configured';
    throw err;
  }

  let accessToken;
  if (provider === 'facebook') {
    const tokenUrl = new URL(spec.token);
    tokenUrl.searchParams.set('client_id', clientId);
    tokenUrl.searchParams.set('client_secret', clientSecret);
    tokenUrl.searchParams.set('redirect_uri', redirectUri);
    tokenUrl.searchParams.set('code', code);
    const tokenRes = await fetchImpl(tokenUrl);
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      const err = new Error(tokenJson.error?.message || 'Facebook token exchange failed');
      err.code = 'oauth_failed';
      throw err;
    }
    accessToken = tokenJson.access_token;
    const infoUrl = new URL(spec.userinfo);
    infoUrl.searchParams.set('fields', 'id,email,first_name,last_name');
    infoUrl.searchParams.set('access_token', accessToken);
    const infoRes = await fetchImpl(infoUrl);
    const info = await infoRes.json();
    if (!infoRes.ok || info.error) {
      const err = new Error(info.error?.message || 'Facebook profile request failed');
      err.code = 'oauth_failed';
      throw err;
    }
    return profileFromProvider(provider, info);
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (spec.pkce && verifier) body.set('code_verifier', verifier);
  const tokenRes = await fetchImpl(spec.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) {
    const err = new Error(tokenJson.error_description || tokenJson.error || 'Token exchange failed');
    err.code = 'oauth_failed';
    throw err;
  }
  const infoRes = await fetchImpl(spec.userinfo, {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  const info = await infoRes.json();
  if (!infoRes.ok) {
    const err = new Error('Profile request failed');
    err.code = 'oauth_failed';
    throw err;
  }
  if (provider === 'microsoft') {
    const idClaims = decodeJwtPayload(tokenJson.id_token);
    const ms = microsoftEmailVerified(idClaims, { clientId, sub: info.sub });
    const merged = { ...info, email_verified: ms.verified };
    for (const k of ['given_name', 'family_name', 'name']) {
      if (!merged[k] && idClaims && idClaims[k]) merged[k] = idClaims[k];
    }
    // The verified address is the one in the id_token. Userinfo can carry a
    // different, unchecked email; do not link that one.
    if (ms.verified) merged.email = ms.email;
    return profileFromProvider(provider, merged);
  }
  return profileFromProvider(provider, info);
}
