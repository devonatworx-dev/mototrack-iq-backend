import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(os.tmpdir(), `mtiq-oauth-${process.pid}.db`);

process.env.JWT_SECRET = ['test-jwt-secret', 'not-for-production', '0123456789'].join('-');
process.env.DB_PATH = dbFile;
process.env.FRONTEND_URL = 'http://127.0.0.1:43128';
process.env.API_PUBLIC_URL = 'http://127.0.0.1:43128';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'poc-google-client.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'poc-google-secret';
process.env.MICROSOFT_OAUTH_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'poc-microsoft-secret';
process.env.FACEBOOK_OAUTH_CLIENT_ID = '123456789012345';
process.env.FACEBOOK_OAUTH_CLIENT_SECRET = 'poc-facebook-secret';
process.env.FACEBOOK_OAUTH_ENABLED = 'false';

const require = createRequire(path.join(root, 'package.json'));
const bcrypt = require('bcryptjs');
const express = require('express');

const { initDb, createRider, updateRider, getRiderByEmail, getEntitlement, getOAuthIdentity } = await import('../lib/db.js');
const { default: authRoutes } = await import('../routes/auth.js');

let server;
let base;
const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function mockProvider(handler) {
  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    if (href.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return handler(href, opts);
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

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

async function start(provider, query = '') {
  const res = await fetch(`${base}/api/auth/oauth/${provider}/start${query}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
}

test('phase 1 lists Google and Microsoft and hides Facebook', async () => {
  const res = await fetch(`${base}/api/auth/oauth/providers`);
  const body = await res.json();
  assert.deepEqual(body.providers, ['google', 'microsoft']);
  assert.equal(body.facebookEnabled, false);
  assert.equal(body.phase, 1);
  const blocked = await start('facebook');
  assert.equal(blocked.status, 404);
  assert.match(blocked.body, /not enabled/);
});

test('Google and Microsoft start redirects hit the provider authorize endpoints', async () => {
  const google = await start('google');
  assert.equal(google.status, 302);
  const g = new URL(google.location);
  assert.equal(g.origin, 'https://accounts.google.com');
  assert.equal(g.pathname, '/o/oauth2/v2/auth');
  assert.equal(g.searchParams.get('client_id'), process.env.GOOGLE_OAUTH_CLIENT_ID);
  assert.equal(g.searchParams.get('redirect_uri'), 'http://127.0.0.1:43128/api/auth/oauth/google/callback');
  assert.equal(g.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(g.searchParams.get('state'));
  assert.match(g.searchParams.get('scope'), /openid/);
  assert.match(g.searchParams.get('scope'), /email/);

  const ms = await start('microsoft');
  assert.equal(ms.status, 302);
  const m = new URL(ms.location);
  assert.equal(m.origin, 'https://login.microsoftonline.com');
  assert.equal(m.pathname, '/common/oauth2/v2.0/authorize');
  assert.equal(m.searchParams.get('redirect_uri'), 'http://127.0.0.1:43128/api/auth/oauth/microsoft/callback');
  assert.match(m.searchParams.get('scope'), /\bemail\b/);
});

test('a verified Google sign-up creates a rider with consent, Ontario, and one free report', async () => {
  const started = await start('google', '?consent=1&ontario=1');
  const state = new URL(started.location).searchParams.get('state');
  mockProvider((href) => {
    if (href.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'g-token' });
    if (href.includes('openidconnect.googleapis.com')) {
      return jsonResponse({
        sub: 'google-ada',
        email: 'ada@example.com',
        email_verified: true,
        given_name: 'Ada',
        family_name: 'Lovelace',
      });
    }
    throw new Error(`unexpected fetch ${href}`);
  });
  const back = await fetch(`${base}/api/auth/oauth/google/callback?code=abc&state=${state}`, { redirect: 'manual' });
  assert.equal(back.status, 302);
  const landed = new URL(back.headers.get('location'));
  assert.equal(landed.origin, 'http://127.0.0.1:43128');
  const code = landed.searchParams.get('oauth_code');
  assert.ok(code);

  const exchanged = await fetch(`${base}/api/auth/oauth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const session = await exchanged.json();
  assert.equal(session.success, true);
  assert.equal(session.isNew, true);
  assert.equal(session.rider.email, 'ada@example.com');
  assert.equal(session.rider.verified, 1);
  assert.ok(session.rider.consentAt);
  assert.ok(session.rider.ontarioAttestedAt);
  assert.equal(session.rider.passwordHash, undefined);
  const ent = getEntitlement(session.rider.id);
  assert.equal(ent.reportCredits, 1);
  assert.equal(ent.canGenerate, true);

  const change = await fetch(`${base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ currentPassword: 'whatever', newPassword: 'Whatever1' }),
  });
  const changeBody = await change.json();
  assert.equal(change.status, 400);
  assert.match(changeBody.error, /Google or Microsoft/);

  const again = await fetch(`${base}/api/auth/oauth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(again.status, 400);

  const plan = await fetch(`${base}/api/auth/select-plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ plan: 'per_event' }),
  });
  const chosen = await plan.json();
  assert.equal(chosen.success, true);
  assert.equal(chosen.plan, 'per_event');
});

test('the same verified email links to an existing password account without replacing the password', async () => {
  const hash = bcrypt.hashSync('TrackDay1', 10);
  createRider({
    id: 'rider-grace',
    firstName: 'Grace',
    lastName: 'Hopper',
    email: 'grace@example.com',
    passwordHash: hash,
    ontarioAttestedAt: '2026-01-01T00:00:00.000Z',
    consentAt: '2026-01-01T00:00:00.000Z',
  });
  updateRider('rider-grace', { verified: 1, reportCredits: 1 });

  const started = await start('microsoft');
  const state = new URL(started.location).searchParams.get('state');
  mockProvider((href) => {
    if (href.includes('login.microsoftonline.com') && href.includes('/token')) {
      return jsonResponse({ access_token: 'm-token', id_token: fakeIdToken({ aud: process.env.MICROSOFT_OAUTH_CLIENT_ID, sub: 'ms-grace', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', email: 'grace@example.com' }) });
    }
    if (href.includes('graph.microsoft.com/oidc/userinfo')) {
      // Real Graph userinfo has no email_verified claim.
      return jsonResponse({
        sub: 'ms-grace',
        email: 'grace@example.com',
        given_name: 'Grace',
        family_name: 'Hopper',
      });
    }
    throw new Error(`unexpected fetch ${href}`);
  });
  const back = await fetch(`${base}/api/auth/oauth/microsoft/callback?code=xyz&state=${state}`, { redirect: 'manual' });
  const code = new URL(back.headers.get('location')).searchParams.get('oauth_code');
  const session = await (await fetch(`${base}/api/auth/oauth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })).json();
  assert.equal(session.isNew, false);
  assert.equal(session.rider.id, 'rider-grace');
  assert.ok(getOAuthIdentity('microsoft', 'ms-grace'));

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'grace@example.com', password: 'TrackDay1' }),
  });
  const logged = await login.json();
  assert.equal(logged.success, true);
  assert.equal(logged.rider.id, 'rider-grace');
  const stored = getRiderByEmail('grace@example.com');
  assert.equal(stored.passwordHash, hash);
});

test('an unverified provider email does not link or create', async () => {
  const started = await start('google');
  const state = new URL(started.location).searchParams.get('state');
  mockProvider((href) => {
    if (href.includes('/token')) return jsonResponse({ access_token: 't' });
    return jsonResponse({ sub: 'google-unverified', email: 'grace@example.com', email_verified: false });
  });
  const back = await fetch(`${base}/api/auth/oauth/google/callback?code=nope&state=${state}`, { redirect: 'manual' });
  const landed = new URL(back.headers.get('location'));
  assert.equal(landed.searchParams.get('oauth_error'), 'email_unverified');
  assert.equal(getOAuthIdentity('google', 'google-unverified'), null);
  assert.equal(getRiderByEmail('grace@example.com').id, 'rider-grace');
});

test('a new Google user without consent is not saved', async () => {
  const started = await start('google');
  const state = new URL(started.location).searchParams.get('state');
  mockProvider((href) => {
    if (href.includes('/token')) return jsonResponse({ access_token: 't' });
    return jsonResponse({
      sub: 'google-new',
      email: 'new@example.com',
      email_verified: true,
      given_name: 'New',
      family_name: 'Rider',
    });
  });
  const back = await fetch(`${base}/api/auth/oauth/google/callback?code=c&state=${state}`, { redirect: 'manual' });
  assert.equal(new URL(back.headers.get('location')).searchParams.get('oauth_error'), 'consent_required');
  assert.equal(getRiderByEmail('new@example.com'), null);
});

test('a cancelled provider consent and a replayed state do not sign anyone in', async () => {
  const started = await start('google', '?consent=1&ontario=1');
  const state = new URL(started.location).searchParams.get('state');
  const denied = await fetch(`${base}/api/auth/oauth/google/callback?error=access_denied&state=${state}`, { redirect: 'manual' });
  assert.equal(new URL(denied.headers.get('location')).searchParams.get('oauth_error'), 'access_denied');
  const replay = await fetch(`${base}/api/auth/oauth/google/callback?code=abc&state=${state}`, { redirect: 'manual' });
  assert.equal(new URL(replay.headers.get('location')).searchParams.get('oauth_error'), 'oauth_failed');
});

test('Facebook starts only when the feature flag is on, and then goes to Facebook', async () => {
  process.env.FACEBOOK_OAUTH_ENABLED = 'true';
  const listed = await (await fetch(`${base}/api/auth/oauth/providers`)).json();
  assert.deepEqual(listed.providers, ['google', 'microsoft', 'facebook']);
  assert.equal(listed.phase, 2);
  const fb = await start('facebook');
  assert.equal(fb.status, 302);
  const u = new URL(fb.location);
  assert.equal(u.origin, 'https://www.facebook.com');
  assert.equal(u.pathname, '/v21.0/dialog/oauth');
  assert.equal(u.searchParams.get('scope'), 'email,public_profile');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:43128/api/auth/oauth/facebook/callback');
  assert.equal(u.searchParams.get('code_challenge'), null);
  process.env.FACEBOOK_OAUTH_ENABLED = 'false';
});


function fakeIdToken(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

test('Microsoft email verification comes from the id_token, not userinfo', async () => {
  const { microsoftEmailVerified } = await import('../lib/oauth.js');
  const cid = 'client-1';
  const personal = { aud: cid, sub: 's1', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', email: 'A@outlook.com' };
  assert.deepEqual(microsoftEmailVerified(personal, { clientId: cid, sub: 's1' }), { verified: true, email: 'a@outlook.com' });
  const work = { aud: cid, sub: 's2', tid: 'some-tenant', email: 'b@corp.example' };
  assert.equal(microsoftEmailVerified(work, { clientId: cid, sub: 's2' }).verified, false);
  assert.equal(microsoftEmailVerified({ ...work, xms_edov: true }, { clientId: cid, sub: 's2' }).verified, true);
  assert.equal(microsoftEmailVerified({ ...personal, aud: 'other' }, { clientId: cid, sub: 's1' }).verified, false);
  assert.equal(microsoftEmailVerified({ ...personal, sub: 'zzz' }, { clientId: cid, sub: 's1' }).verified, false);
  assert.equal(microsoftEmailVerified(null).verified, false);
});

test('a provider with no client id is listed but refuses to start, and the process stays up', async () => {
  const savedId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  try {
    const listed = await (await fetch(`${base}/api/auth/oauth/providers`)).json();
    assert.deepEqual(listed.providers, ['google', 'microsoft']);
    const res = await fetch(`${base}/api/auth/oauth/google/start`, { redirect: 'manual' });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'oauth_not_configured');
    const ms = await fetch(`${base}/api/auth/oauth/microsoft/start`, { redirect: 'manual' });
    assert.equal(ms.status, 302);
  } finally {
    process.env.GOOGLE_OAUTH_CLIENT_ID = savedId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedSecret;
  }
});
