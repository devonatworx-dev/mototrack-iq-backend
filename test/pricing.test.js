import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(os.tmpdir(), `mtiq-pricing-${process.pid}.db`);

process.env.JWT_SECRET = ['test-jwt-secret', 'not-for-production', '0123456789'].join('-');
process.env.DB_PATH = dbFile;
process.env.ADMIN_KEY = ['pricing', 'admin', 'key'].join('-');
process.env.FRONTEND_URL = 'http://127.0.0.1:43128';
process.env.TURNSTILE_ENABLED = 'false';

const require = createRequire(path.join(root, 'package.json'));
const jwt = require('jsonwebtoken');

const db = await import('../lib/db.js');
const { settleOAuthAccount } = await import('../lib/oauth-account.js');
const { normalizeSessionDay } = await import('../lib/pricing.js');
const { app } = await import('../server.js');

let server;
let base;

const CSV = [
  'Record,Time,Latitude,Longitude,Altitude,Speed,GForceX,GForceZ,Lap,LeanAngle,GyroX,GyroY,GyroZ',
  '1,2026-07-04T14:00:00Z,44.2,-77.1,100,80,0.1,0.1,1,5,0,0,0',
  '2,2026-07-04T14:00:01Z,44.201,-77.101,100,90,0.1,0.1,1,6,0,0,0',
].join('\n');

function token(riderId) {
  return jwt.sign({ riderId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function day(n) {
  return `2026-07-${String(n).padStart(2, '0')}`;
}

before(async () => {
  fs.rmSync(dbFile, { force: true });
  await db.initDb();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dbFile, { force: true });
});

test('signup credit is one per rider across email create and OAuth link', async () => {
  const emailRider = db.createRider({
    id: 'email-rider', firstName: 'Em', lastName: 'Ail', email: 'both@example.com', passwordHash: 'x',
  });
  assert.equal(emailRider.reportCredits, 1);
  assert.equal(Number(emailRider.signupCreditGranted), 1);
  db.addReportCredits('email-rider', 2);
  assert.equal(db.getRiderById('email-rider').reportCredits, 3);

  const linked = settleOAuthAccount({
    provider: 'google',
    providerUserId: 'gid-both',
    email: 'both@example.com',
    emailVerified: true,
    firstName: 'Em',
    lastName: 'Ail',
  }, { ontario: true });
  assert.equal(linked.linked, true);
  assert.equal(linked.isNew, false);
  assert.equal(db.getRiderById('email-rider').reportCredits, 3);
  db.grantSignupCreditOnce('email-rider');
  assert.equal(db.getRiderById('email-rider').reportCredits, 3);

  const created = settleOAuthAccount({
    provider: 'google',
    providerUserId: 'gid-new',
    email: 'oauth-only@example.com',
    emailVerified: true,
    firstName: 'O',
    lastName: 'Auth',
  }, { ontario: true });
  assert.equal(created.isNew, true);
  assert.equal(created.rider.reportCredits, 1);
  const again = settleOAuthAccount({
    provider: 'google',
    providerUserId: 'gid-new',
    email: 'oauth-only@example.com',
    emailVerified: true,
    firstName: 'O',
    lastName: 'Auth',
  }, { ontario: true });
  assert.equal(again.isNew, false);
  assert.equal(db.getRiderById(created.rider.id).reportCredits, 1);

  db.updateRider('email-rider', { signupCreditGranted: 0 });
  db.grantSignupCreditOnce('email-rider');
  assert.equal(db.getRiderById('email-rider').reportCredits, 4);
  db.grantSignupCreditOnce('email-rider');
  assert.equal(db.getRiderById('email-rider').reportCredits, 4);
});

test('admin create stores the credits argument as the balance', async () => {
  const headers = { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_KEY };
  const specified = await fetch(`${base}/api/admin/riders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ firstName: 'Ada', email: 'ada-admin@example.com', password: 'secret1', credits: 4 }),
  });
  const specifiedBody = await specified.json();
  assert.equal(specified.status, 201);
  assert.equal(specifiedBody.rider.reportCredits, 4);
  assert.equal(specifiedBody.entitlement.reportCredits, 4);

  const omitted = await fetch(`${base}/api/admin/riders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ firstName: 'Bea', email: 'bea-admin@example.com', password: 'secret1' }),
  });
  const omittedBody = await omitted.json();
  assert.equal(omitted.status, 201);
  assert.equal(omittedBody.rider.reportCredits, 1);

  const zero = await fetch(`${base}/api/admin/riders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ firstName: 'Cy', email: 'cy-admin@example.com', password: 'secret1', credits: 0 }),
  });
  assert.equal((await zero.json()).rider.reportCredits, 0);
});

test('an event pass is 6 credits that can be spent across days', () => {
  const id = 'event-rider';
  db.createRider({ id, firstName: 'Ev', lastName: 'Ent', email: 'event@example.com', passwordHash: 'x' });
  db.updateRider(id, { reportCredits: 0 });
  db.grantPass(id, 'event', { orderId: 'ord-event' });
  const fresh = db.getEntitlement(id);
  assert.equal(fresh.passes.event[0].dailyCap, null);
  assert.equal(fresh.passes.event[0].maxDays, null);
  assert.equal(fresh.passes.event[0].boundDate, undefined);
  assert.equal(fresh.dayReport.event, true);
  assert.equal(fresh.dayReport.season, false);
  assert.equal(fresh.dayReport.anyDate, true);
  assert.equal(fresh.dayReport.minimumSessions, 2);
  assert.equal(fresh.dayReport.eventDates, undefined);

  for (const sessionDate of ['2026-08-01', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-03', '2026-08-04']) {
    const charge = db.consumeSessionCredit(id, { sessionDate });
    assert.equal(charge.ok, true, charge.code);
    assert.equal(charge.source, 'event');
  }
  const spent = db.consumeSessionCredit(id, { sessionDate: '2026-08-09' });
  assert.equal(spent.ok, false);
  assert.equal(spent.code, 'out_of_credits');
  assert.equal(db.getRiderById(id).reportCredits, 0);
  assert.equal(db.getEntitlement(id).passes.event[0].creditsRemaining, 0);
  assert.equal(db.getEntitlement(id).dayReport.included, true);
  assert.equal(db.dayReportAccess(id, '2026-08-01', 2).ok, true);
  assert.equal(db.dayReportAccess(id, '2026-08-09', 2).ok, true);
  assert.equal(db.dayReportAccess(id, '2026-08-01', 1).code, 'day_report_needs_multiple_sessions');
});

test('season pass is 8 event days of at most 6, not a 48-credit wallet', () => {
  const id = 'season-rider';
  db.createRider({ id, firstName: 'Sea', lastName: 'Son', email: 'season@example.com', passwordHash: 'x' });
  db.updateRider(id, { reportCredits: 0, plan: 'free' });
  db.grantPass(id, 'season');
  const undated = db.consumeSessionCredit(id, {});
  assert.equal(undated.ok, false);
  assert.equal(undated.code, 'session_date_required');
  const ent = db.getEntitlement(id);
  assert.equal(ent.unlimited, false);
  assert.equal(ent.passes.season[0].creditsRemaining, 48);
  assert.equal(ent.passes.season[0].maxDays, 8);
  assert.equal(ent.dayReport.anyDate, true);
  assert.equal(ent.dayReport.event, false);
  assert.equal(ent.dayReport.minimumSessions, 2);

  for (let d = 1; d <= 8; d++) {
    const charge = db.consumeSessionCredit(id, { sessionDate: day(d) });
    assert.equal(charge.ok, true, `${day(d)} ${charge.code}`);
    assert.equal(charge.source, 'season');
  }
  assert.equal(db.getEntitlement(id).passes.season[0].creditsRemaining, 40);
  assert.equal(db.getEntitlement(id).passes.season[0].daysUsed, 8);

  const ninth = db.consumeSessionCredit(id, { sessionDate: day(9) });
  assert.equal(ninth.ok, false);
  assert.equal(ninth.code, 'season_days_exhausted');
  assert.equal(db.getEntitlement(id).passes.season[0].creditsRemaining, 40);

  for (let i = 0; i < 5; i++) {
    const more = db.consumeSessionCredit(id, { sessionDate: day(1) });
    assert.equal(more.ok, true, more.code);
    assert.equal(more.source, 'season');
  }
  const seventh = db.consumeSessionCredit(id, { sessionDate: day(1) });
  assert.equal(seventh.ok, false);
  assert.equal(seventh.code, 'daily_session_cap');
  assert.equal(db.getEntitlement(id).passes.season[0].creditsRemaining, 35);
  assert.equal(db.getRiderById(id).reportCredits, 0);
});

test('single credits have no daily cap and are not used before a season day', () => {
  const id = 'stack-rider';
  db.createRider({ id, firstName: 'Stack', lastName: 'Ed', email: 'stack@example.com', passwordHash: 'x' });
  db.updateRider(id, { reportCredits: 1 });
  db.grantPass(id, 'season');
  db.grantPass(id, 'event');

  const first = db.consumeSessionCredit(id, { sessionDate: '2026-10-01' });
  assert.equal(first.source, 'season');
  assert.equal(db.getRiderById(id).reportCredits, 1);
  assert.equal(db.getEntitlement(id).passes.event[0].creditsRemaining, 6);

  for (let i = 0; i < 5; i++) db.consumeSessionCredit(id, { sessionDate: '2026-10-01' });
  const seventh = db.consumeSessionCredit(id, { sessionDate: '2026-10-01' });
  assert.equal(seventh.source, 'event');
  assert.equal(db.getRiderById(id).reportCredits, 1);
  assert.equal(db.getEntitlement(id).passes.event[0].creditsRemaining, 5);

  for (let d = 2; d <= 8; d++) {
    assert.equal(db.consumeSessionCredit(id, { sessionDate: `2026-10-${String(d).padStart(2, '0')}` }).source, 'season');
  }
  const extraDay = db.consumeSessionCredit(id, { sessionDate: '2026-10-09' });
  assert.equal(extraDay.source, 'event');
  assert.equal(db.getEntitlement(id).passes.event[0].creditsRemaining, 4);
  assert.equal(db.getRiderById(id).reportCredits, 1);
});

test('seven single credits can be used on one day', () => {
  const id = 'single-rider';
  db.createRider({ id, firstName: 'Sing', lastName: 'Le', email: 'single@example.com', passwordHash: 'x' });
  db.updateRider(id, { reportCredits: 7 });
  for (let i = 0; i < 7; i++) {
    const charge = db.consumeSessionCredit(id, { sessionDate: '2026-11-01' });
    assert.equal(charge.source, 'flex');
  }
  assert.equal(db.consumeSessionCredit(id, { sessionDate: '2026-11-01' }).code, 'out_of_credits');
});

test('a paid session is not charged again, and a refund restores an event day', () => {
  const id = 'refund-rider';
  db.createRider({ id, firstName: 'Re', lastName: 'Fund', email: 'refund@example.com', passwordHash: 'x' });
  db.updateRider(id, { reportCredits: 0 });
  db.grantPass(id, 'event');
  db.createSession({
    id: 'refund-session',
    riderId: id,
    date: '2026-12-01',
    analysisData: { summary: { trackName: 'Test', sessionDate: '2026-12-01' }, laps: [], lapStats: { best: 1, count: 1 } },
  });
  const charge = db.consumeSessionCredit(id, { sessionDate: '2026-12-01', sessionId: 'refund-session' });
  assert.equal(charge.source, 'event');
  assert.equal(Number(db.getSessionById('refund-session').creditConsumed), 1);
  assert.equal(db.getEntitlement(id).passes.event[0].creditsRemaining, 5);

  const again = db.consumeSessionCredit(id, { sessionDate: '2026-12-01', sessionId: 'refund-session' });
  assert.equal(again.duplicate, true);
  assert.equal(db.getEntitlement(id).passes.event[0].creditsRemaining, 5);

  db.refundSessionCredit(id, charge);
  const restored = db.getEntitlement(id);
  assert.equal(restored.passes.event[0].creditsRemaining, 6);
  assert.equal(restored.reportsGenerated, 0);
});

test('grandfathered plan=season stays unlimited with no credits', () => {
  const id = 'legacy-season';
  db.createRider({ id, firstName: 'Old', lastName: 'Season', email: 'legacy@example.com', passwordHash: 'x' });
  db.updateRider(id, { plan: 'season', reportCredits: 0 });
  const ent = db.getEntitlement(id);
  assert.equal(ent.unlimited, true);
  assert.equal(ent.canGenerate, true);
  assert.equal(ent.dayReport.anyDate, true);
  assert.equal(ent.dayReport.included, true);
  assert.equal(ent.dayReport.minimumSessions, 2);
  assert.equal(db.dayReportAccess(id, '2026-06-15', 1).code, 'day_report_needs_multiple_sessions');
  assert.equal(db.dayReportAccess(id, '2026-06-15', 2).ok, true);
  const charge = db.consumeSessionCredit(id, { sessionDate: '2026-06-15' });
  assert.equal(charge.source, 'unlimited');
  assert.equal(db.getRiderById(id).reportCredits, 0);
  assert.equal(db.getEntitlement(id).passes.season.length, 0);
});

test('session date must be a real calendar day', () => {
  assert.equal(normalizeSessionDay('2026-07-04'), '2026-07-04');
  assert.equal(normalizeSessionDay('2026-07-04T23:30:00-04:00'), '2026-07-04');
  assert.equal(normalizeSessionDay('2026-02-31'), null);
  assert.equal(normalizeSessionDay('July 4, 2026'), null);
});

test('report email copy no longer promises a free season', () => {
  const src = fs.readFileSync(path.join(root, 'lib/email.js'), 'utf8');
  assert.equal(src.includes('Early-Rider Special'), false);
  assert.equal(src.includes('Beta riders get it free'), false);
  assert.equal(src.includes('2026 season'), false);
  assert.equal(src.includes('Claim my beta spot'), false);
  assert.equal(src.includes('CA$5.99'), true);
  assert.equal(src.includes('CA$19.99'), true);
  assert.equal(src.includes('CA$89.99'), true);
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.equal(serverSrc.includes('PDF download is now FREE'), false);
  const lsSrc = fs.readFileSync(path.join(root, 'lib/lemonsqueezy.js'), 'utf8');
  assert.equal(lsSrc.includes('LS_VARIANT_BUNDLE'), false);
  assert.equal(lsSrc.includes('special_event_bundle'), false);
});

test('saving a session spends one credit and the PDF does not spend another', async () => {
  const id = 'http-rider';
  db.createRider({ id, firstName: 'Http', lastName: 'Rider', email: 'http@example.com', passwordHash: 'x' });
  db.updateRider(id, { verified: 1, reportCredits: 1 });
  const auth = { authorization: `Bearer ${token(id)}`, 'content-type': 'application/json' };

  const analyzed = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ csv: CSV }),
  });
  assert.equal(analyzed.status, 200);
  assert.equal(db.getRiderById(id).reportCredits, 1);

  const saved = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ csvContent: CSV, date: '2026-07-04', name: 'Saturday' }),
  });
  const savedBody = await saved.json();
  assert.equal(saved.status, 201, JSON.stringify(savedBody));
  assert.equal(savedBody.charged, 'flex');
  assert.equal(savedBody.chargedDay, '2026-07-04');
  assert.equal(savedBody.reportCredits, 0);
  assert.equal(savedBody.askReview, true);
  assert.equal(db.getRiderById(id).reportCredits, 0);
  assert.equal(Number(db.getSessionById(savedBody.session.id).creditConsumed), 1);

  const report = await fetch(`${base}/api/sessions/${savedBody.session.id}/report`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(report.status, 200, await report.clone().text());
  assert.equal(report.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await report.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
  assert.equal(db.getRiderById(id).reportCredits, 0);
  assert.equal(db.getRiderById(id).reportsGenerated, 1);

  const again = await fetch(`${base}/api/sessions/${savedBody.session.id}/report`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(again.status, 200);
  assert.equal(db.getRiderById(id).reportCredits, 0);
  assert.equal(db.getRiderById(id).reportsGenerated, 1);

  const denied = await fetch(`${base}/api/sessions/day-report`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ date: '2026-07-04' }),
  });
  const deniedBody = await denied.json();
  assert.equal(denied.status, 402);
  assert.equal(deniedBody.code, 'day_report_not_included');
  assert.equal(deniedBody.paywall, true);

  db.grantPass(id, 'event');
  const tooFew = await fetch(`${base}/api/sessions/day-report`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ date: '2026-07-04' }),
  });
  const tooFewBody = await tooFew.json();
  assert.equal(tooFew.status, 400);
  assert.equal(tooFewBody.code, 'day_report_needs_multiple_sessions');
  assert.equal(tooFewBody.paywall, false);
  assert.equal(tooFewBody.sessionCount, 1);
  assert.equal(tooFewBody.minimumSessions, 2);

  const emptyDay = await fetch(`${base}/api/sessions/day-report`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ date: '2026-07-05' }),
  });
  assert.equal(emptyDay.status, 400);
  assert.equal((await emptyDay.json()).code, 'day_report_needs_multiple_sessions');

  db.createSession({
    id: 'http-second',
    riderId: id,
    date: '2026-07-04',
    name: 'Second',
    analysisData: { summary: { trackName: 'Test', sessionDate: '2026-07-04' }, laps: [{ lap: 1, time: 91 }], lapStats: { count: 1, best: 91 } },
  });
  const allowed = await fetch(`${base}/api/sessions/day-report`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ date: '2026-07-04' }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('content-type'), 'application/pdf');
  const entitlement = await (await fetch(`${base}/api/sessions/entitlement`, { headers: auth })).json();
  assert.equal(entitlement.entitlement.dayReport.event, true);
  assert.equal(entitlement.entitlement.dayReport.season, false);
  assert.equal(entitlement.entitlement.dayReport.anyDate, true);
  assert.equal(entitlement.entitlement.dayReport.minimumSessions, 2);
  assert.equal(entitlement.entitlement.unlimited, false);
});

test('analyze does not open a session for a rider with no credits', async () => {
  const id = 'broke-rider';
  db.createRider({ id, firstName: 'Bro', lastName: 'Ke', email: 'broke@example.com', passwordHash: 'x' });
  db.updateRider(id, { verified: 1, reportCredits: 0 });
  const res = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token(id)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ csv: CSV }),
  });
  const body = await res.json();
  assert.equal(res.status, 402);
  assert.equal(body.code, 'out_of_credits');
  assert.equal(body.paywall, true);
  assert.equal(db.getRiderById(id).reportCredits, 0);
});
