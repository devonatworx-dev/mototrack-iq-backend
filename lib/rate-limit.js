const buckets = new Map();

/**
 * Fixed window per IP. Each `name` has its own counter, so a burst of
 * password resets does not lock registration.
 */
export function rateLimit({ name, windowMs, max }) {
  return function limit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    const now = Date.now();
    const recent = (buckets.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (recent.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - recent[0])) / 1000);
      res.set('retry-after', String(Math.max(retryAfter, 1)));
      return res.status(429).json({
        error: 'Too many attempts. Try again in a few minutes.',
        code: 'rate_limited',
      });
    }
    recent.push(now);
    buckets.set(key, recent);
    next();
  };
}

export function resetRateLimits() {
  buckets.clear();
}

export function authRateLimit(name, env = process.env) {
  return rateLimit({
    name,
    windowMs: Number(env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
    max: Number(env.AUTH_RATE_LIMIT_MAX || 8),
  });
}
