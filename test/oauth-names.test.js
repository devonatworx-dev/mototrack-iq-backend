import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeCode, profileFromProvider } from '../lib/oauth.js';

test('microsoft display name is split when given/family missing', () => {
  const p = profileFromProvider('microsoft', { sub: 'x', email: 'a@b.com', email_verified: true, name: 'Devon Smith Jr' });
  assert.equal(p.firstName, 'Devon'); assert.equal(p.lastName, 'Smith Jr');
});
test('given/family preferred over name', () => {
  const p = profileFromProvider('google', { sub: 'x', email: 'a@b.com', email_verified: true, given_name: 'A', family_name: 'B', name: 'Z Y' });
  assert.equal(p.firstName, 'A'); assert.equal(p.lastName, 'B');
});
test('email-like name is ignored', () => {
  const p = profileFromProvider('microsoft', { sub: 'x', email: 'a@b.com', email_verified: true, name: 'a@b.com' });
  assert.equal(p.firstName, '');
});

function fakeIdToken(claims) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

test('microsoft id_token supplies the display name and the personal-tenant verification', async () => {
  const env = {
    MICROSOFT_OAUTH_CLIENT_ID: 'cid',
    MICROSOFT_OAUTH_CLIENT_SECRET: 'sec',
  };
  const profile = await exchangeCode({
    provider: 'microsoft',
    code: 'c',
    verifier: 'v',
    redirectUri: 'http://127.0.0.1/cb',
    env,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 't',
            id_token: fakeIdToken({
              aud: 'cid',
              sub: 'ms-devon',
              tid: '9188040d-6c67-4c5b-b112-36a304b66dad',
              email: 'devon@outlook.com',
              name: 'Devon Smith Jr',
            }),
          }),
        };
      }
      return { ok: true, json: async () => ({ sub: 'ms-devon' }) };
    },
  });
  assert.equal(profile.firstName, 'Devon');
  assert.equal(profile.lastName, 'Smith Jr');
  assert.equal(profile.email, 'devon@outlook.com');
  assert.equal(profile.emailVerified, true);
});

test('a verified id_token email replaces a different userinfo email', async () => {
  const profile = await exchangeCode({
    provider: 'microsoft',
    code: 'c',
    verifier: 'v',
    redirectUri: 'http://127.0.0.1/cb',
    env: { MICROSOFT_OAUTH_CLIENT_ID: 'cid', MICROSOFT_OAUTH_CLIENT_SECRET: 'sec' },
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 't',
            id_token: fakeIdToken({
              aud: 'cid',
              sub: 'ms-devon',
              tid: '9188040d-6c67-4c5b-b112-36a304b66dad',
              email: 'real@outlook.com',
              name: 'Devon Smith',
            }),
          }),
        };
      }
      return { ok: true, json: async () => ({ sub: 'ms-devon', email: 'other@example.com' }) };
    },
  });
  assert.equal(profile.email, 'real@outlook.com');
  assert.equal(profile.emailVerified, true);
  assert.equal(profile.firstName, 'Devon');
});

test('a work account without xms_edov is not treated as verified', async () => {
  const profile = await exchangeCode({
    provider: 'microsoft',
    code: 'c',
    verifier: 'v',
    redirectUri: 'http://127.0.0.1/cb',
    env: { MICROSOFT_OAUTH_CLIENT_ID: 'cid', MICROSOFT_OAUTH_CLIENT_SECRET: 'sec' },
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 't',
            id_token: fakeIdToken({
              aud: 'cid',
              sub: 'ms-work',
              tid: 'some-tenant',
              email: 'devon@corp.example',
              name: 'Devon Smith',
            }),
          }),
        };
      }
      return { ok: true, json: async () => ({ sub: 'ms-work', email: 'devon@corp.example', name: 'Devon Smith' }) };
    },
  });
  assert.equal(profile.emailVerified, false);
  assert.equal(profile.firstName, 'Devon');
});

test('missing OAuth client env does not throw until the token exchange', async () => {
  await assert.rejects(
    () => exchangeCode({
      provider: 'google',
      code: 'c',
      redirectUri: 'http://127.0.0.1/cb',
      env: {},
      fetchImpl: async () => { throw new Error('network should not be called'); },
    }),
    (err) => err.code === 'oauth_not_configured',
  );
});
