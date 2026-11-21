import test from 'node:test';
import assert from 'node:assert/strict';
import {
  oauthHandoffCounts,
  resetOAuthHandoff,
  saveOAuthCode,
  saveOAuthState,
  takeOAuthCode,
  takeOAuthState,
} from '../lib/oauth-handoff.js';

function future(ms = 60_000) {
  return new Date(Date.now() + ms).toISOString();
}

test('state and code are single-use and expired rows are dropped', () => {
  resetOAuthHandoff();
  saveOAuthState({
    state: 'old',
    provider: 'google',
    verifier: 'v',
    consent: true,
    ontario: true,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  saveOAuthState({
    state: 'fresh',
    provider: 'microsoft',
    verifier: 'verifier',
    consent: false,
    ontario: true,
    expiresAt: future(),
  });
  assert.equal(oauthHandoffCounts().states, 1);
  assert.equal(takeOAuthState('old'), null);
  const row = takeOAuthState('fresh');
  assert.equal(row.provider, 'microsoft');
  assert.equal(row.verifier, 'verifier');
  assert.equal(row.consent, 0);
  assert.equal(row.ontario, 1);
  assert.equal(takeOAuthState('fresh'), null);

  saveOAuthCode({ code: 'gone', riderId: 'r1', isNew: false, expiresAt: new Date(Date.now() - 5).toISOString() });
  saveOAuthCode({ code: 'live', riderId: 'r2', isNew: true, expiresAt: future() });
  assert.equal(oauthHandoffCounts().codes, 1);
  assert.equal(takeOAuthCode('gone'), null);
  const code = takeOAuthCode('live');
  assert.equal(code.rider_id, 'r2');
  assert.equal(code.is_new, 1);
  assert.equal(takeOAuthCode('live'), null);
  assert.deepEqual(oauthHandoffCounts(), { states: 0, codes: 0 });
  resetOAuthHandoff();
});
