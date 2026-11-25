import { isIP } from 'node:net';

const buckets = new Map();

/**
 * One address token, with a trailing :port removed.
 *
 * proxy-addr (what Express uses for req.ip) keeps whatever text the trusted
 * hop put in X-Forwarded-For. Some proxies append the source port, and that
 * port changes on every connection, so a limiter keyed on the raw string
 * never reaches its max. Railway's own edge does not publish the source
 * port, but it also does not promise a fixed X-Forwarded-For hop count:
 * with `trust proxy` set to 1, req.ip is often the edge address, not the
 * rider. Rate limits therefore key on X-Real-IP, which Railway's public
 * edge overwrites with the single client address.
 */
export function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  let v = value.trim();
  if (!v) return '';
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end > 1) v = v.slice(1, end);
  } else if (v.includes('.')) {
    const colon = v.lastIndexOf(':');
    if (colon > 0 && v.indexOf(':') === colon && /^\d+$/.test(v.slice(colon + 1))) {
      v = v.slice(0, colon);
    }
  }
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  if (v.toLowerCase().startsWith('::ffff:')) {
    const mapped = v.slice(7);
    if (isIP(mapped) === 4) return mapped;
  }
  return isIP(v) ? v : '';
}

function readHeader(req, name) {
  if (typeof req.get === 'function') {
    const value = req.get(name);
    if (value != null) return value;
  }
  const headers = req.headers;
  if (!headers) return undefined;
  return headers[String(name).toLowerCase()];
}

function addressList(value) {
  if (Array.isArray(value)) value = value.join(',');
  if (typeof value !== 'string') return [];
  const found = [];
  for (const part of value.split(',')) {
    const ip = normalizeIp(part);
    if (ip) found.push(ip);
  }
  return found;
}

export function clientIp(req) {
  // First valid address only. A comma-joined suffix (a request id, a second
  // hop) must not become part of the bucket key, or each call is a new key
  // and the limiter never returns 429.
  const real = addressList(readHeader(req, 'x-real-ip'));
  if (real.length) return real[0];
  const expressIp = normalizeIp(typeof req.ip === 'string' ? req.ip : '');
  if (expressIp) return expressIp;
  const socketIp = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress || '');
  return socketIp || 'unknown';
}

/** Mailbox key. Plus-tags alias one inbox; the stored account email is unchanged. */
export function emailLimitKey(email) {
  const norm = String(email || '').trim().toLowerCase();
  const at = norm.lastIndexOf('@');
  if (at < 1 || at === norm.length - 1) return '';
  let local = norm.slice(0, at);
  const domain = norm.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus !== -1) local = local.slice(0, plus);
  if (!local || !domain || domain.includes('@')) return '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function pruneBuckets(now) {
  for (const [key, entry] of buckets) {
    const recent = entry.stamps.filter((stamp) => now - stamp < entry.windowMs);
    if (recent.length === 0) buckets.delete(key);
    else entry.stamps = recent;
  }
}

export function rateLimitBucketCount() {
  return buckets.size;
}

export function rateLimit({ name, windowMs, max, keyFn, cooldownMs = 0 }) {
  return function limit(req, res, next) {
    const id = keyFn ? keyFn(req) : clientIp(req);
    if (!id) return next();
    const key = `${name}:${id}`;
    const now = Date.now();
    pruneBuckets(now);
    const recent = buckets.get(key)?.stamps || [];
    const cooling = cooldownMs > 0 && recent.length > 0 && (now - recent[recent.length - 1]) < cooldownMs;
    if (recent.length >= max || cooling) {
      const retryAfter = cooling
        ? Math.ceil((cooldownMs - (now - recent[recent.length - 1])) / 1000)
        : Math.ceil((windowMs - (now - recent[0])) / 1000);
      res.set('retry-after', String(Math.max(retryAfter, 1)));
      return res.status(429).json({
        error: 'Too many attempts. Try again in a few minutes.',
        code: 'rate_limited',
      });
    }
    recent.push(now);
    buckets.set(key, { stamps: recent, windowMs: Math.max(windowMs, cooldownMs) });
    next();
  };
}

export function resetRateLimits() {
  buckets.clear();
}

export function authRateLimit(name, env = process.env) {
  // Read on each request so a deployed cap cannot be baked in as NaN or a
  // huge number at import, and so tests can tighten the window.
  return function limit(req, res, next) {
    return rateLimit({
      name,
      // A configured max above this clamp cannot turn the limiter off.
      // 40 in 15 minutes still covers a paddock sharing one NAT address.
      windowMs: boundedInt(env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
      max: boundedInt(env.AUTH_RATE_LIMIT_MAX, 8, 1, 40),
    })(req, res, next);
  };
}

/**
 * Per-address cap for routes that send mail. Runs after the IP limiter and
 * does not say whether an account exists: unknown addresses consume a slot too.
 */
export function emailSendLimit(name, env = process.env) {
  return function limit(req, res, next) {
    return rateLimit({
      name: `email:${name}`,
      windowMs: boundedInt(env.AUTH_EMAIL_WINDOW_MS, 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
      max: boundedInt(env.AUTH_EMAIL_MAX, 5, 1, 20),
      cooldownMs: boundedInt(env.AUTH_EMAIL_COOLDOWN_MS, 60_000, 0, 60 * 60 * 1000),
      keyFn(req2) {
        return emailLimitKey(req2.body?.email);
      },
    })(req, res, next);
  };
}
