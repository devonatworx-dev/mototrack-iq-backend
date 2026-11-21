import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OAUTH_HANDOFF_CAP,
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

test('each handoff map stops at 10000 and evicts the oldest', () => {
  resetOAuthHandoff();
  const expiresAt = future();
  for (let i = 0; i < OAUTH_HANDOFF_CAP; i++) {
    saveOAuthState({
      state: `s${i}`,
      provider: 'google',
      verifier: 'v',
      consent: false,
      ontario: false,
      expiresAt,
    });
  }
  assert.equal(oauthHandoffCounts().states, OAUTH_HANDOFF_CAP);
  saveOAuthState({
    state: 's-new',
    provider: 'microsoft',
    verifier: 'v',
    consent: true,
    ontario: false,
    expiresAt,
  });
  assert.equal(oauthHandoffCounts().states, OAUTH_HANDOFF_CAP);
  assert.equal(takeOAuthState('s0'), null);
  assert.equal(takeOAuthState('s1').provider, 'google');
  const newest = takeOAuthState('s-new');
  assert.equal(newest.provider, 'microsoft');
  assert.equal(newest.consent, 1);

  for (let i = 0; i < OAUTH_HANDOFF_CAP; i++) {
    saveOAuthCode({ code: `c${i}`, riderId: 'r', isNew: false, expiresAt });
  }
  const statesBefore = oauthHandoffCounts().states;
  saveOAuthCode({ code: 'c-new', riderId: 'r2', isNew: true, expiresAt });
  assert.equal(oauthHandoffCounts().codes, OAUTH_HANDOFF_CAP);
  assert.equal(oauthHandoffCounts().states, statesBefore);
  assert.equal(takeOAuthCode('c0'), null);
  assert.equal(takeOAuthCode('c-new').rider_id, 'r2');
  resetOAuthHandoff();
});
