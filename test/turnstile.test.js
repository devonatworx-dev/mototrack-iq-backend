import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(os.tmpdir(), `mtiq-turnstile-${process.pid}.db`);

// Cloudflare's documented dummy keys. The pass secret accepts XXXX.DUMMY.TOKEN.XXXX.
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const PASS_SECRET = '1x0000000000000000000000000000000AA';
const FAIL_SECRET = '2x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const PASS_SITE_KEY = '1x00000000000000000000AA';

process.env.JWT_SECRET = ['test-jwt-secret', 'not-for-production', '0123456789'].join('-');
process.env.DB_PATH = dbFile;
process.env.FRONTEND_URL = 'http://127.0.0.1:43128';
process.env.API_PUBLIC_URL = 'http://127.0.0.1:43128';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'poc-google-client.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'poc-google-secret';
process.env.MICROSOFT_OAUTH_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'poc-microsoft-secret';
process.env.FACEBOOK_OAUTH_ENABLED = 'false';
process.env.TURNSTILE_ENABLED = 'false';
process.env.TURNSTILE_SITE_KEY = PASS_SITE_KEY;
process.env.TURNSTILE_SECRET_KEY = '';
process.env.AUTH_RATE_LIMIT_MAX = '3';
process.env.AUTH_RATE_LIMIT_WINDOW_MS = '60000';

const require = createRequire(path.join(root, 'package.json'));
const express = require('express');
const { initDb } = await import('../lib/db.js');
const { default: authRoutes } = await import('../routes/auth.js');
const { resetRateLimits } = await import('../lib/rate-limit.js');

let server;
let base;

before(async () => {
  fs.rmSync(dbFile, { force: true });
  await initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dbFile, { force: true });
});

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
}

test('Turnstile stays off by default and the secret is not in the public config', async () => {
  const res = await fetch(`${base}/api/auth/oauth/providers`);
  const body = await res.json();
  assert.deepEqual(body.turnstile, { enabled: false, siteKey: null });
  assert.equal(JSON.stringify(body).includes('SECRET'), false);
  const register = await post('/api/auth/register', {});
  assert.equal(register.status, 400);
  assert.notEqual(register.body.code, 'turnstile_failed');
});

test('social start does not require a Turnstile token', async () => {
  process.env.TURNSTILE_ENABLED = 'true';
  process.env.TURNSTILE_SECRET_KEY = PASS_SECRET;
  const res = await fetch(`${base}/api/auth/oauth/google/start`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location')).origin, 'https://accounts.google.com');
});

test('Cloudflare test keys accept the dummy token and reject the failing secret', async () => {
  process.env.TURNSTILE_ENABLED = 'true';
  process.env.TURNSTILE_SITE_KEY = PASS_SITE_KEY;
  process.env.TURNSTILE_SECRET_KEY = FAIL_SECRET;
  const blocked = await post('/api/auth/register', { turnstileToken: DUMMY_TOKEN });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'turnstile_failed');

  const missing = await post('/api/auth/login', { email: 'a@b.c', password: 'x' });
  assert.equal(missing.status, 403);

  process.env.TURNSTILE_SECRET_KEY = PASS_SECRET;
  const passed = await post('/api/auth/register', { turnstileToken: DUMMY_TOKEN });
  assert.equal(passed.status, 400);
  assert.match(passed.body.error, /firstName/);

  const listed = await (await fetch(`${base}/api/auth/oauth/providers`)).json();
  assert.equal(listed.turnstile.enabled, true);
  assert.equal(listed.turnstile.siteKey, PASS_SITE_KEY);
});

test('register, login, forgot-password, and resend-verification are limited per IP', async () => {
  process.env.TURNSTILE_ENABLED = 'false';
  resetRateLimits();
  for (const path of ['/api/auth/register', '/api/auth/forgot-password', '/api/auth/resend-verification', '/api/auth/login']) {
    resetRateLimits();
    const body = path.endsWith('register') ? {} : (path.endsWith('login') ? { email: 'nobody@example.com', password: 'nope' } : { email: 'nobody@example.com' });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(path, body)).status);
    assert.deepEqual(statuses.slice(0, 3).every((code) => code !== 429), true, path);
    assert.equal(statuses[3], 429, path);
  }
});
