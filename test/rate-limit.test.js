import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, rateLimit, resetRateLimits } from '../lib/rate-limit.js';

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
