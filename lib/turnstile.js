const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function isTurnstileEnabled(env = process.env) {
  const value = String(env.TURNSTILE_ENABLED || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** Public half of the config. The secret never leaves the server. */
export function turnstilePublicConfig(env = process.env) {
  const enabled = isTurnstileEnabled(env);
  const siteKey = (env.TURNSTILE_SITE_KEY || '').trim();
  return { enabled, siteKey: enabled && siteKey ? siteKey : null };
}

/**
 * POST the widget token to Cloudflare. When the flag is off this returns
 * success without a network call. When the flag is on, a missing secret or
 * a failed siteverify is a rejection (fail closed).
 */
export async function verifyTurnstile({ token, remoteip, env = process.env, fetchImpl = fetch } = {}) {
  if (!isTurnstileEnabled(env)) return { success: true, skipped: true };
  const secret = (env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret || !token) {
    return { success: false, 'error-codes': ['missing-input-secret'] };
  }
  const body = new URLSearchParams({ secret, response: String(token) });
  if (remoteip) body.set('remoteip', remoteip);
  const res = await fetchImpl(SITEVERIFY, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return { success: false, 'error-codes': ['siteverify-http'] };
  return res.json();
}

export function requireTurnstile(req, res, next) {
  verifyTurnstile({ token: req.body?.turnstileToken, remoteip: req.ip })
    .then((result) => {
      if (result?.success) return next();
      res.status(403).json({ error: 'Security check failed. Try again.', code: 'turnstile_failed' });
    })
    .catch(() => {
      res.status(403).json({ error: 'Security check failed. Try again.', code: 'turnstile_failed' });
    });
}
