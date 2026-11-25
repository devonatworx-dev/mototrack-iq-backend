import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(os.tmpdir(), `mtiq-casl-${process.pid}.db`);
const legacyJson = path.join(os.tmpdir(), `mtiq-casl-beta-${process.pid}.json`);

process.env.JWT_SECRET = ['test-jwt-secret', 'not-for-production', '0123456789'].join('-');
process.env.DB_PATH = dbFile;
process.env.ADMIN_KEY = 'casl-admin-key';
process.env.FRONTEND_URL = 'http://127.0.0.1:43128';
process.env.API_PUBLIC_URL = 'http://api.test.local';
process.env.TURNSTILE_ENABLED = 'false';
process.env.AUTH_RATE_LIMIT_MAX = '40';
process.env.AUTH_RATE_LIMIT_WINDOW_MS = '60000';
process.env.AUTH_EMAIL_COOLDOWN_MS = '0';
process.env.AUTH_EMAIL_MAX = '20';
process.env.AUTH_EMAIL_WINDOW_MS = '3600000';
delete process.env.BUSINESS_MAILING_ADDRESS;
delete process.env.UNSUBSCRIBE_SECRET;
delete process.env.REPORT_LINK_SECRET;
delete process.env.GOOGLE_REFRESH_TOKEN;

const require = createRequire(path.join(root, 'package.json'));
const express = require('express');
const initSqlJs = (await import('sql.js')).default;

fs.rmSync(dbFile, { force: true });
const SQL = await initSqlJs();
const seed = new SQL.Database();
seed.run(`
  CREATE TABLE riders (
    id TEXT PRIMARY KEY,
    firstName TEXT NOT NULL,
    lastName TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    passwordHash TEXT,
    experience TEXT,
    riderType TEXT,
    bikes TEXT,
    primaryTrack TEXT,
    lapTimer TEXT,
    notes TEXT,
    verified INTEGER DEFAULT 0,
    verifyToken TEXT,
    verifyTokenExpiry TEXT,
    consentAt TEXT,
    ontarioAttestedAt TEXT,
    plan TEXT,
    resetToken TEXT,
    resetTokenExpiry TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);
seed.run(
  `INSERT INTO riders (id, firstName, lastName, email, passwordHash, verified, consentAt, createdAt, updatedAt)
   VALUES ('legacy-rider', 'Legacy', 'Rider', 'legacy.rider@example.com', 'hash', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
);
seed.run(`
  CREATE TABLE beta_signups (
    id TEXT PRIMARY KEY,
    firstName TEXT NOT NULL,
    lastName TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    bike TEXT,
    track TEXT,
    experience TEXT,
    source TEXT,
    consent INTEGER NOT NULL,
    confirmed INTEGER DEFAULT 0,
    confirmToken TEXT,
    confirmedAt TEXT,
    confirmTokenExpiry TEXT,
    submittedAt TEXT,
    ip TEXT,
    createdAt TEXT NOT NULL
  )
`);
seed.run(
  `INSERT INTO beta_signups (id, firstName, lastName, email, consent, confirmed, createdAt)
   VALUES ('beta-legacy', 'Wait', 'List', 'legacy.beta@example.com', 1, 1, '2026-05-01T00:00:00.000Z')`
);
fs.writeFileSync(dbFile, Buffer.from(seed.export()));
seed.close();

const db = await import('../lib/db.js');
const casl = await import('../lib/casl.js');
const emailLib = await import('../lib/email.js');
const { default: authRoutes } = await import('../routes/auth.js');
const { default: adminRoutes } = await import('../routes/admin.js');
const { default: emailRoutes } = await import('../routes/email.js');
const { resetRateLimits } = await import('../lib/rate-limit.js');

await db.initDb();

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/email', emailRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dbFile, { force: true });
  fs.rmSync(legacyJson, { force: true });
});

async function post(urlPath, body, headers = {}) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.80', ...headers },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, text };
}

function riderBody(email, extra = {}) {
  return {
    firstName: 'Ada',
    lastName: 'Rider',
    email,
    ontarioResident: true,
    ...extra,
  };
}

test('legacy riders and beta contacts are not consented for marketing', () => {
  const rider = db.getRiderByEmail('legacy.rider@example.com');
  assert.equal(rider.consentAt, '2026-01-01T00:00:00.000Z');
  assert.equal(Number(rider.marketingConsent), 0);
  assert.equal(rider.marketingConsentAt, null);

  const beta = db.getBetaSignupByEmail('legacy.beta@example.com');
  assert.equal(Number(beta.consent), 1);
  assert.equal(Number(beta.marketingConsent), 0);
  const records = db.getMarketingConsentRecords('legacy.beta@example.com');
  assert.equal(records.length, 1);
  assert.equal(records[0].source, 'legacy_beta');
  assert.equal(Number(records[0].granted), 0);
  assert.equal(db.recipientAllowsMarketing('legacy.beta@example.com'), false);
  assert.equal(db.recipientAllowsMarketing('legacy.rider@example.com'), false);
  assert.equal(db.listMarketingRecipients().some((row) => row.email === 'legacy.beta@example.com'), false);
});

test('a legacy JSON import is stored as not consented for marketing', async () => {
  fs.writeFileSync(legacyJson, JSON.stringify([{
    email: 'Imported@Example.com',
    firstName: 'Im',
    lastName: 'Port',
    consent: true,
  }]));
  const result = await db.migrateLegacyBetaSignups(legacyJson);
  assert.equal(result.migrated, 1);
  const row = db.getBetaSignupByEmail('Imported@Example.com');
  assert.equal(Number(row.marketingConsent), 0);
  assert.equal(Number(row.consent), 1);
  const records = db.getMarketingConsentRecords('imported@example.com');
  assert.ok(records.some((r) => r.source === 'legacy_beta' && Number(r.granted) === 0));
  assert.equal(db.recipientAllowsMarketing('imported@example.com'), false);
});

test('register stores marketing consent as optional and does not grant it on verify', async () => {
  resetRateLimits();
  const omitted = await post('/api/auth/register', riderBody('omit@example.com'));
  assert.equal(omitted.status, 200);
  const omittedRider = db.getRiderByEmail('omit@example.com');
  assert.equal(Number(omittedRider.marketingConsent), 0);
  assert.equal(omittedRider.marketingConsentSource, 'register');
  assert.ok(omittedRider.marketingConsentAt);
  assert.equal(omittedRider.consentAt, null);
  const omittedRecords = db.getMarketingConsentRecords('omit@example.com');
  assert.equal(omittedRecords.length, 1);
  assert.equal(Number(omittedRecords[0].granted), 0);

  const opted = await post('/api/auth/register', riderBody('opt-in@example.com', { marketingConsent: true }));
  assert.equal(opted.status, 200);
  let optedRider = db.getRiderByEmail('opt-in@example.com');
  assert.equal(Number(optedRider.marketingConsent), 1);
  const stamped = optedRider.marketingConsentAt;

  const verified = await post('/api/auth/verify', { token: optedRider.verifyToken });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.success, true);
  optedRider = db.getRiderByEmail('opt-in@example.com');
  assert.equal(Number(optedRider.verified), 1);
  assert.equal(Number(optedRider.marketingConsent), 1);
  assert.equal(optedRider.marketingConsentAt, stamped);
  assert.equal(optedRider.consentAt, null);

  const declined = await post('/api/auth/register', riderBody('opt-out@example.com', { marketingConsent: false }));
  assert.equal(declined.status, 200);
  let declinedRider = db.getRiderByEmail('opt-out@example.com');
  await post('/api/auth/verify', { token: declinedRider.verifyToken });
  declinedRider = db.getRiderByEmail('opt-out@example.com');
  assert.equal(Number(declinedRider.verified), 1);
  assert.equal(Number(declinedRider.marketingConsent), 0);
  assert.equal(declinedRider.consentAt, null);

  for (const value of ['false', 'yes', 'on', 0, null]) {
    const email = `no-${String(value)}@example.com`.replace(/[^a-z0-9@.-]/g, 'x');
    const res = await post('/api/auth/register', riderBody(email, { marketingConsent: value }), { 'x-real-ip': '203.0.113.81' });
    assert.equal(res.status, 200, email);
    assert.equal(Number(db.getRiderByEmail(email).marketingConsent), 0, email);
  }
  const asString = await post('/api/auth/register', riderBody('string-true@example.com', { marketingConsent: 'true' }), { 'x-real-ip': '203.0.113.82' });
  assert.equal(asString.status, 200);
  assert.equal(Number(db.getRiderByEmail('string-true@example.com').marketingConsent), 1);
  const asOne = await post('/api/auth/register', riderBody('one@example.com', { marketingConsent: 1 }), { 'x-real-ip': '203.0.113.83' });
  assert.equal(asOne.status, 200);
  assert.equal(Number(db.getRiderByEmail('one@example.com').marketingConsent), 1);
});

test('a pending registration can change its mind, and a finished account cannot be opted in by registering again', async () => {
  resetRateLimits();
  await post('/api/auth/register', riderBody('pending@example.com', { marketingConsent: true }), { 'x-real-ip': '203.0.113.84' });
  await post('/api/auth/register', riderBody('pending@example.com', { marketingConsent: false }), { 'x-real-ip': '203.0.113.85' });
  assert.equal(Number(db.getRiderByEmail('pending@example.com').marketingConsent), 0);

  await post('/api/auth/register', riderBody('finished@example.com'), { 'x-real-ip': '203.0.113.86' });
  const finished = db.getRiderByEmail('finished@example.com');
  db.updateRider(finished.id, { verified: 1, passwordHash: 'hash' });
  await post('/api/auth/register', riderBody('finished@example.com', { marketingConsent: true }), { 'x-real-ip': '203.0.113.87' });
  const after = db.getRiderByEmail('finished@example.com');
  assert.equal(Number(after.marketingConsent), 0);
  assert.equal(after.marketingConsentSource, 'register');
});

test('unsubscribe withdraws marketing consent from a signed link and rejects a bad token', async () => {
  resetRateLimits();
  await post('/api/auth/register', riderBody('unsub@example.com', { marketingConsent: true }), { 'x-real-ip': '203.0.113.88' });
  const rider = db.getRiderByEmail('unsub@example.com');
  const token = casl.signUnsubscribeToken({ riderId: rider.id, email: rider.email });
  const ok = await fetch(`${base}/api/email/unsubscribe?token=${encodeURIComponent(token)}`);
  const html = await ok.text();
  assert.equal(ok.status, 200);
  assert.match(html, /You are unsubscribed/);
  assert.match(html, /MotoTrackIQ/);
  assert.match(html, /\[Mailing address coming soon\]/);
  assert.equal(Number(db.getRiderByEmail('unsub@example.com').marketingConsent), 0);
  assert.equal(db.getRiderByEmail('unsub@example.com').marketingConsentSource, 'unsubscribe');
  assert.equal(db.recipientAllowsMarketing('unsub@example.com'), false);

  const again = await fetch(`${base}/api/email/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.equal(again.status, 200);
  assert.match(await again.text(), /You are unsubscribed/);

  await post('/api/auth/register', riderBody('post-unsub@example.com', { marketingConsent: true }), { 'x-real-ip': '203.0.113.89' });
  const second = db.getRiderByEmail('post-unsub@example.com');
  const secondToken = casl.signUnsubscribeToken({ riderId: second.id, email: second.email });
  const posted = await fetch(`${base}/api/email/unsubscribe?token=${encodeURIComponent(secondToken)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  assert.equal(posted.status, 200);
  assert.equal(Number(db.getRiderByEmail('post-unsub@example.com').marketingConsent), 0);

  const bad = await fetch(`${base}/api/email/unsubscribe?token=${encodeURIComponent(token.slice(0, -2) + 'zz')}`);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /not valid/);
  assert.equal(Number(db.getRiderByEmail('post-unsub@example.com').marketingConsent), 0);
});

test('commercial mail carries the CASL footer and list-unsubscribe headers, and is refused without consent', async () => {
  const blocked = await emailLib.sendBetaInviteEmail('legacy.beta@example.com', 'Wait');
  assert.deepEqual(blocked, { success: false, error: 'marketing_consent_required' });
  const follow = await emailLib.sendRiderFollowupEmail('omit@example.com', 'Ada', {});
  assert.equal(follow.error, 'marketing_consent_required');
  assert.equal(emailLib.commercialEnvelopeFor('omit@example.com'), null);

  const rider = db.getRiderByEmail('opt-in@example.com');
  assert.equal(Number(rider.marketingConsent), 1);
  const envelope = emailLib.commercialEnvelopeFor(rider.email);
  assert.ok(envelope.unsubscribeUrl.startsWith('http://api.test.local/api/email/unsubscribe?token='));
  const html = emailLib.buildBetaInviteHtml('Ada', { unsubscribeUrl: envelope.unsubscribeUrl });
  assert.match(html, /Unsubscribe/);
  assert.match(html, /\[Mailing address coming soon\]/);
  assert.match(html, /info@mototrackiq.com/);
  assert.match(html, /MotoTrackIQ/);
  const raw = Buffer.from(emailLib.encodeMessage(rider.email, 'Beta', html, envelope.headers), 'base64url').toString('utf8');
  assert.match(raw, /List-Unsubscribe: <http:\/\/api.test.local\/api\/email\/unsubscribe\?token=/);
  assert.match(raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);

  const verifyHtml = emailLib.buildVerifyEmailHtml('Ada', 'tok', 'opt-in@example.com');
  assert.doesNotMatch(verifyHtml, /Unsubscribe/);
  assert.doesNotMatch(verifyHtml, /opts you in/i);
  assert.match(verifyHtml, /does not sign you up for marketing/);
  const verifyRaw = Buffer.from(emailLib.encodeMessage('opt-in@example.com', 'Confirm', verifyHtml), 'base64url').toString('utf8');
  assert.equal(verifyRaw.includes('List-Unsubscribe'), false);

  const sent = await emailLib.sendBetaInviteEmail(rider.email, 'Ada');
  assert.equal(sent.success, false);
  assert.notEqual(sent.error, 'marketing_consent_required');
  assert.equal(db.listMarketingRecipients().some((row) => row.email === rider.email), true);
  assert.equal(db.listMarketingRecipients().some((row) => row.email === 'omit@example.com'), false);
});

test('a missing mailing address warns once and a configured address is escaped into the footer', () => {
  delete process.env.BUSINESS_MAILING_ADDRESS;
  casl.resetMailingAddressWarningForTests();
  const logs = [];
  const orig = console.warn;
  console.warn = (msg) => logs.push(String(msg));
  try {
    assert.equal(casl.mailingAddress(), '[Mailing address coming soon]');
    assert.equal(casl.warnIfMailingAddressMissing(), true);
    assert.equal(casl.warnIfMailingAddressMissing(), false);
    assert.ok(logs.some((line) => line.includes('BUSINESS_MAILING_ADDRESS')));
    assert.ok(logs.some((line) => line.includes('[Mailing address coming soon]')));
  } finally {
    console.warn = orig;
  }

  process.env.BUSINESS_MAILING_ADDRESS = '1 <script>alert(1)</script> Street\nBrampton ON';
  const html = casl.caslFooterHtml('https://api.test.local/api/email/unsubscribe?token=abc');
  assert.match(html, /1 &lt;script&gt;alert\(1\)&lt;\/script&gt; Street<br>Brampton ON/);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /unsubscribe\?token=abc/);
  delete process.env.BUSINESS_MAILING_ADDRESS;
});

test('unsubscribe tokens use UNSUBSCRIBE_SECRET when set and do not require a new JWT secret', () => {
  const rider = db.getRiderByEmail('opt-in@example.com');
  const first = casl.signUnsubscribeToken({ riderId: rider.id, email: rider.email });
  assert.deepEqual(casl.verifyUnsubscribeToken(first), { riderId: rider.id, email: rider.email });
  process.env.UNSUBSCRIBE_SECRET = 'dedicated-unsubscribe-secret';
  assert.equal(casl.verifyUnsubscribeToken(first), null);
  const second = casl.signUnsubscribeToken({ riderId: rider.id, email: rider.email });
  assert.ok(casl.verifyUnsubscribeToken(second));
  assert.equal(process.env.JWT_SECRET, ['test-jwt-secret', 'not-for-production', '0123456789'].join('-'));
  delete process.env.UNSUBSCRIBE_SECRET;
  assert.ok(casl.verifyUnsubscribeToken(first));
});

test('the admin rider list shows consent status and admin-created accounts are not opted in', async () => {
  const created = await post('/api/admin/riders', {
    firstName: 'Track',
    lastName: 'Side',
    email: 'trackside@example.com',
    password: 'secret1',
  }, { 'x-admin-key': process.env.ADMIN_KEY, 'x-real-ip': '203.0.113.90' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(Number(created.body.rider.marketingConsent), 0);
  assert.equal(created.body.rider.marketingConsentSource, 'admin');

  const list = await fetch(`${base}/api/admin/riders`, { headers: { 'x-admin-key': process.env.ADMIN_KEY } });
  const body = await list.json();
  assert.equal(list.status, 200);
  const row = body.riders.find((r) => r.email === 'opt-in@example.com');
  assert.ok(row);
  assert.equal(Number(row.marketingConsent), 1);
  assert.equal(row.marketingConsentSource, 'register');
  assert.ok(row.marketingConsentAt);
  const legacy = body.riders.find((r) => r.email === 'legacy.rider@example.com');
  assert.equal(Number(legacy.marketingConsent), 0);
});
