import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(os.tmpdir(), `mtiq-security-${process.pid}.db`);

process.env.JWT_SECRET = ['test-jwt-secret', 'not-for-production', '0123456789'].join('-');
process.env.DB_PATH = dbFile;
process.env.FRONTEND_URL = 'http://127.0.0.1:43128';
process.env.API_PUBLIC_URL = 'http://127.0.0.1:43128';
process.env.TURNSTILE_ENABLED = 'false';
process.env.AUTH_RATE_LIMIT_MAX = '3';
process.env.AUTH_RATE_LIMIT_WINDOW_MS = '60000';
process.env.AUTH_EMAIL_COOLDOWN_MS = '60000';
process.env.AUTH_EMAIL_MAX = '5';
process.env.AUTH_EMAIL_WINDOW_MS = '3600000';
process.env.DEVICE_INGEST_TOKEN = 'device-test-token';
process.env.INGEST_MAX_BATCH_BYTES = '1024';
process.env.INGEST_MAX_SLOT_BYTES = '1024';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'poc-google-client.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'poc-google-secret';
process.env.MICROSOFT_OAUTH_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'poc-microsoft-secret';
process.env.FACEBOOK_OAUTH_ENABLED = 'false';

const require = createRequire(path.join(root, 'package.json'));
const express = require('express');
const jwt = require('jsonwebtoken');

const { initDb, createRider, createSession, updateRider } = await import('../lib/db.js');
const { default: authRoutes } = await import('../routes/auth.js');
const { default: ingestRoutes } = await import('../routes/ingest.js');
const { default: deviceRoutes } = await import('../routes/device-reports.js');
const { resetRateLimits } = await import('../lib/rate-limit.js');

let server;
let base;

before(async () => {
  fs.rmSync(dbFile, { force: true });
  await initDb();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/sessions/ingest', ingestRoutes);
  app.use('/api/device', deviceRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dbFile, { force: true });
});

async function post(urlPath, body, headers = {}) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

test('waitlist routes are gone and the signup table helpers remain', () => {
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const adminSrc = fs.readFileSync(path.join(root, 'routes/admin.js'), 'utf8');
  assert.equal(serverSrc.includes('/api/beta-signup'), false);
  assert.equal(serverSrc.includes('/api/beta/confirm'), false);
  assert.equal(serverSrc.includes('/api/beta/resend'), false);
  assert.equal(serverSrc.includes('/api/beta/count'), false);
  assert.equal(serverSrc.includes('/api/admin/signups'), false);
  assert.equal(adminSrc.includes("'/signups'"), false);
  assert.equal(fs.existsSync(path.join(root, 'routes/beta.js')), false);
  const dbSrc = fs.readFileSync(path.join(root, 'lib/db.js'), 'utf8');
  assert.match(dbSrc, /CREATE TABLE IF NOT EXISTS beta_signups/);
  assert.match(dbSrc, /export async function migrateLegacyBetaSignups/);
});

test('one IP is limited even when each request uses a different mailbox', async () => {
  resetRateLimits();
  const headers = { 'x-real-ip': '203.0.113.20', 'x-forwarded-for': '198.51.100.1, 10.0.0.4' };
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const res = await post('/api/auth/forgot-password', { email: `person${i}@example.com` }, headers);
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[3], 429);
});

test('the same mailbox is limited across source addresses, including plus-tags', async () => {
  resetRateLimits();
  const first = await post('/api/auth/resend-verification', { email: 'Rider@Example.com' }, { 'x-real-ip': '203.0.113.30' });
  const second = await post('/api/auth/resend-verification', { email: 'rider+burst@example.com' }, { 'x-real-ip': '203.0.113.31' });
  const other = await post('/api/auth/resend-verification', { email: 'someone-else@example.com' }, { 'x-real-ip': '203.0.113.32' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(second.body.code, 'rate_limited');
  assert.equal(other.status, 200);
});

test('a configured IP max above the clamp still returns 429', async () => {
  process.env.AUTH_RATE_LIMIT_MAX = '100000';
  resetRateLimits();
  try {
    const headers = { 'x-real-ip': '203.0.113.40' };
    let limitedAt = -1;
    for (let i = 0; i < 41; i++) {
      const res = await post('/api/auth/login', { email: `clamp${i}@example.com`, password: 'nope' }, headers);
      if (res.status === 429) {
        limitedAt = i;
        break;
      }
    }
    // Clamp is 40, so the 41st request (index 40) is the first 429.
    assert.equal(limitedAt, 40);
  } finally {
    process.env.AUTH_RATE_LIMIT_MAX = '3';
    resetRateLimits();
  }
});

test('register stores a clean name and does not reveal an existing account', async () => {
  resetRateLimits();
  createRider({
    id: 'already',
    firstName: 'Pat',
    lastName: 'Rider',
    email: 'pat@example.com',
    passwordHash: 'hash',
  });
  updateRider('already', { verified: 1 });

  const headers = { 'x-real-ip': '203.0.113.60' };
  const known = await post('/api/auth/register', {
    firstName: 'Pat', lastName: 'Rider', email: 'pat@example.com', ontarioResident: true,
  }, headers);
  const fresh = await post('/api/auth/register', {
    firstName: '  Ada  ', lastName: "O'Brien", email: 'ada@example.com', ontarioResident: true,
  }, headers);
  assert.equal(known.status, 200);
  assert.equal(fresh.status, 200);
  assert.deepEqual(known.body, fresh.body);
  assert.equal(JSON.stringify(known.body).toLowerCase().includes('already'), false);
  const { getRiderByEmail } = await import('../lib/db.js');
  const ada = getRiderByEmail('ada@example.com');
  assert.equal(ada.firstName, 'Ada');
  assert.equal(ada.lastName, "O'Brien");

  const markup = await post('/api/auth/register', {
    firstName: '<script>Ada</script>', lastName: 'Rider', email: 'xss@example.com', ontarioResident: true,
  }, { 'x-real-ip': '203.0.113.61' });
  assert.equal(markup.status, 400);
  assert.equal(getRiderByEmail('xss@example.com'), null);
});

test('ingest and device reads require auth, cap size, and clean header names', async () => {
  resetRateLimits();
  const open = await fetch(base + '/api/sessions/ingest', {
    method: 'POST',
    headers: { 'content-type': 'text/csv', 'x-rider-name': '<script>x</script>Ada' },
    body: '1,2,3\n',
  });
  assert.equal(open.status, 401);

  const named = await fetch(base + '/api/sessions/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'text/csv',
      'x-device-token': 'device-test-token',
      'x-rider-name': '<script>alert(1)</script>Ada',
      'x-device-slot': '2',
    },
    body: '1,2,3\n',
  });
  const namedBody = await named.json();
  assert.equal(named.status, 200);
  assert.equal(namedBody.riderName, 'Ada');
  assert.equal(String(namedBody.riderName).includes('<'), false);

  const bulky = await fetch(base + '/api/sessions/ingest', {
    method: 'POST',
    headers: { 'content-type': 'text/csv', 'x-device-token': 'device-test-token', 'x-device-slot': '3' },
    body: `${'1,'.repeat(700)}\n`,
  });
  assert.equal(bulky.status, 413);

  const row = `${'9,'.repeat(300)}\n`;
  const firstFit = await fetch(base + '/api/sessions/ingest', {
    method: 'POST',
    headers: { 'content-type': 'text/csv', 'x-device-token': 'device-test-token', 'x-device-slot': '4' },
    body: row,
  });
  assert.equal(firstFit.status, 200);
  const overflow = await fetch(base + '/api/sessions/ingest', {
    method: 'POST',
    headers: { 'content-type': 'text/csv', 'x-device-token': 'device-test-token', 'x-device-slot': '4' },
    body: row,
  });
  assert.equal(overflow.status, 413);

  const badSlot = await fetch(base + '/api/sessions/ingest', {
    method: 'POST',
    headers: { 'content-type': 'text/csv', 'x-device-token': 'device-test-token', 'x-device-slot': '99' },
    body: '1,2,3\n',
  });
  assert.equal(badSlot.status, 400);

  const todayOpen = await fetch(base + '/api/device/sessions/today');
  assert.equal(todayOpen.status, 401);
  const eodOpen = await fetch(base + '/api/device/eod');
  assert.equal(eodOpen.status, 401);
  const uploadOpen = await post('/api/device/upload', { csv: '1,2\n', riderName: '<b>Ada</b>' });
  assert.equal(uploadOpen.status, 401);

  const today = new Date().toISOString().split('T')[0];
  createSession({
    id: 'sess-1',
    riderId: null,
    deviceName: 'RaceBox',
    riderName: 'Ada',
    slotId: '1',
    name: 'Ada session',
    track: 'Shannonville',
    bike: 'R6',
    date: today,
    csvContent: 'secret-csv-payload',
    analysisData: { laps: [{ time: 90 }] },
  });
  const token = jwt.sign({ riderId: 'rider-1' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const todayAuthed = await fetch(base + '/api/device/sessions/today', {
    headers: { authorization: `Bearer ${token}` },
  });
  const todayBody = await todayAuthed.json();
  assert.equal(todayAuthed.status, 200);
  assert.equal(JSON.stringify(todayBody).includes('secret-csv-payload'), false);
  assert.ok(todayBody.sessions.some((s) => s.id === 'sess-1'));

  const eod = await fetch(base + '/api/device/eod', {
    headers: { 'x-device-token': 'device-test-token' },
  });
  assert.equal(eod.status, 200);
  const eodBody = await eod.json();
  assert.equal(JSON.stringify(eodBody).includes('secret-csv-payload'), false);
  assert.ok(eodBody.sessions.some((s) => s.riderName === 'Ada'));
});
