import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, rateLimit, rateLimitBucketCount, resetRateLimits } from '../lib/rate-limit.js';
import { requireTurnstile } from '../lib/turnstile.js';

function run(limit, { real, ip = '10.0.0.1' } = {}) {
  const req = {
    ip,
    socket: { remoteAddress: '192.0.2.1' },
    get(name) {
      if (name === 'x-real-ip') return real;
      return undefined;
    },
  };
  let status = 0;
  let body;
  const res = {
    set() { return this; },
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  limit(req, res, () => { status = 200; });
  return { status, body };
}

test('X-Real-IP is the rate-limit key, not the proxy address', () => {
  assert.equal(clientIp({ get: () => '203.0.113.9', ip: '10.0.0.1', socket: {} }), '203.0.113.9');
  assert.equal(clientIp({ get: () => '  ', ip: '10.0.0.1', socket: { remoteAddress: '192.0.2.8' } }), '10.0.0.1');
  assert.equal(clientIp({ get: () => undefined, ip: '', socket: { remoteAddress: '192.0.2.8' } }), '192.0.2.8');

  resetRateLimits();
  const limit = rateLimit({ name: 'probe', windowMs: 60_000, max: 1 });
  assert.equal(run(limit, { real: '203.0.113.1', ip: '10.0.0.1' }).status, 200);
  assert.equal(run(limit, { real: '203.0.113.1', ip: '10.9.9.9' }).status, 429);
  assert.equal(run(limit, { real: '203.0.113.2', ip: '10.0.0.1' }).status, 200);
  resetRateLimits();
});

test('a rate-limit bucket is removed once every attempt in it has expired', async () => {
  resetRateLimits();
  const limit = rateLimit({ name: 'idle', windowMs: 20, max: 5 });
  assert.equal(run(limit, { real: '203.0.113.40' }).status, 200);
  assert.equal(run(limit, { real: '203.0.113.41' }).status, 200);
  assert.equal(rateLimitBucketCount(), 2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(run(limit, { real: '203.0.113.42' }).status, 200);
  assert.equal(rateLimitBucketCount(), 1);
  resetRateLimits();
});

test('Turnstile siteverify receives the same X-Real-IP', async () => {
  const previous = process.env.TURNSTILE_ENABLED;
  const previousSecret = process.env.TURNSTILE_SECRET_KEY;
  process.env.TURNSTILE_ENABLED = 'true';
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  const realFetch = globalThis.fetch;
  let seen = '';
  globalThis.fetch = async (_url, opts) => {
    seen = String(opts.body);
    return { ok: true, json: async () => ({ success: true }) };
  };
  try {
    const req = {
      body: { turnstileToken: 'tok' },
      ip: '10.0.0.1',
      socket: { remoteAddress: '192.0.2.1' },
      get(name) { return name === 'x-real-ip' ? '203.0.113.77' : undefined; },
    };
    let status = 0;
    await new Promise((resolve, reject) => {
      requireTurnstile(req, {
        status(code) { status = code; return this; },
        json() { resolve(); },
      }, () => { status = 200; resolve(); });
      setTimeout(() => reject(new Error('turnstile did not settle')), 1000);
    });
    assert.equal(status, 200);
    assert.match(seen, /remoteip=203\.0\.113\.77/);
    assert.equal(seen.includes('10.0.0.1'), false);
  } finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) delete process.env.TURNSTILE_ENABLED;
    else process.env.TURNSTILE_ENABLED = previous;
    if (previousSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = previousSecret;
  }
});
