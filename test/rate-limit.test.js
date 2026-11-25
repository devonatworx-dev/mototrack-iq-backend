import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, normalizeIp, rateLimit, rateLimitBucketCount, resetRateLimits } from '../lib/rate-limit.js';
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
  assert.equal(normalizeIp('203.0.113.9:40001'), '203.0.113.9');
  assert.equal(clientIp({ get: () => '203.0.113.9:40001', ip: '10.0.0.4', socket: {} }), '203.0.113.9');
  assert.equal(clientIp({ get: () => '203.0.113.9, req-9f3a', ip: '10.0.0.4', socket: {} }), '203.0.113.9');

  resetRateLimits();
  const limit = rateLimit({ name: 'probe', windowMs: 60_000, max: 1 });
  assert.equal(run(limit, { real: '203.0.113.1', ip: '10.0.0.1' }).status, 200);
  assert.equal(run(limit, { real: '203.0.113.1', ip: '10.9.9.9' }).status, 429);
  assert.equal(run(limit, { real: '203.0.113.2', ip: '10.0.0.1' }).status, 200);
  resetRateLimits();
  const ports = rateLimit({ name: 'ports', windowMs: 60_000, max: 1 });
  assert.equal(run(ports, { real: '203.0.113.8:40001', ip: '10.0.0.4' }).status, 200);
  assert.equal(run(ports, { real: '203.0.113.8:40099', ip: '10.0.0.9' }).status, 429);
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

test('trust proxy 1 does not use the Railway edge address, and a changing port still returns 429', async () => {
  resetRateLimits();
  const express = (await import('express')).default;
  const app = express();
  app.set('trust proxy', 1);
  const limit = rateLimit({ name: 'rail-http', windowMs: 60_000, max: 2 });
  app.get('/p', limit, (req, res) => {
    res.json({ client: clientIp(req), expressIp: req.ip });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function hit(headers) {
    const res = await fetch(`${base}/p`, { headers });
    const body = await res.json();
    return { status: res.status, body };
  }
  try {
    const first = await hit({
      'x-real-ip': '203.0.113.50',
      'x-forwarded-for': '203.0.113.50, 10.0.0.4',
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.client, '203.0.113.50');
    // One trusted hop is the socket. The next address is Railway's edge, not the rider.
    assert.equal(first.body.expressIp, '10.0.0.4');
    assert.notEqual(first.body.expressIp, first.body.client);

    const second = await hit({
      'x-real-ip': '203.0.113.50:4444',
      'x-forwarded-for': '198.51.100.9, 10.0.0.4',
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.client, '203.0.113.50');

    const third = await hit({
      'x-real-ip': '203.0.113.50:5555',
      'x-forwarded-for': '203.0.113.77, 10.9.9.9',
    });
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'rate_limited');

    const otherRider = await hit({
      'x-real-ip': '203.0.113.51',
      'x-forwarded-for': '203.0.113.51, 10.0.0.4',
    });
    assert.equal(otherRider.status, 200);
    assert.equal(otherRider.body.expressIp, '10.0.0.4');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetRateLimits();
  }
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
