import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(os.tmpdir(), `mtiq-oauth-rl-${process.pid}.db`);

process.env.JWT_SECRET = ['test-jwt-secret', 'not-for-production', '0123456789'].join('-');
process.env.DB_PATH = dbFile;
process.env.FRONTEND_URL = 'http://127.0.0.1:43128';
process.env.API_PUBLIC_URL = 'http://127.0.0.1:43128';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'poc-google-client.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'poc-google-secret';
process.env.MICROSOFT_OAUTH_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'poc-microsoft-secret';
process.env.FACEBOOK_OAUTH_ENABLED = 'false';
process.env.AUTH_RATE_LIMIT_WINDOW_MS = '60000';
process.env.OAUTH_RATE_LIMIT_MAX = '2';

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

async function hit(path, headers) {
  const res = await fetch(base + path, { redirect: 'manual', headers });
  return res.status;
}

test('oauth start and callback are limited per X-Real-IP', async () => {
  resetRateLimits();
  const a = { 'x-real-ip': '203.0.113.10' };
  const b = { 'x-real-ip': '203.0.113.11' };
  assert.equal(await hit('/api/auth/oauth/google/start', a), 302);
  assert.equal(await hit('/api/auth/oauth/google/start', a), 302);
  assert.equal(await hit('/api/auth/oauth/google/start', a), 429);
  assert.equal(await hit('/api/auth/oauth/google/start', b), 302);

  resetRateLimits();
  assert.equal(await hit('/api/auth/oauth/google/callback?error=access_denied', a), 302);
  assert.equal(await hit('/api/auth/oauth/google/callback?error=access_denied', a), 302);
  assert.equal(await hit('/api/auth/oauth/google/callback?error=access_denied', a), 429);
  assert.equal(await hit('/api/auth/oauth/microsoft/callback?error=access_denied', b), 302);
});
