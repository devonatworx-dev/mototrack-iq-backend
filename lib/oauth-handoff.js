/**
 * In-flight OAuth state and the one-time portal code.
 *
 * These used to be rows in sqlite. Every insert rewrote the whole sql.js
 * file, so a burst of anonymous /start calls stalled /health. One Railway
 * instance holds them in memory instead. A restart drops logins that have
 * not finished; it does not touch riders. The service has to stay on one
 * Railway replica: another instance would not see this map. Expired entries
 * are removed on the next save or take. Each map also stops at
 * OAUTH_HANDOFF_CAP and drops the oldest insertion.
 */

const states = new Map();
const codes = new Map();

/** Hard ceiling per map. Past this, the oldest insertion is dropped. */
export const OAUTH_HANDOFF_CAP = 10_000;

function prune(map, now) {
  for (const [key, row] of map) {
    if (!(row.expiresAtMs > now)) map.delete(key);
  }
}

function remember(map, key, row) {
  if (map.has(key)) map.delete(key);
  while (map.size >= OAUTH_HANDOFF_CAP) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, row);
}

export function resetOAuthHandoff() {
  states.clear();
  codes.clear();
}

export function oauthHandoffCounts() {
  return { states: states.size, codes: codes.size };
}

export function saveOAuthState({ state, provider, verifier, consent, ontario, expiresAt }) {
  const now = Date.now();
  prune(states, now);
  prune(codes, now);
  remember(states, state, {
    provider,
    verifier: verifier || '',
    consent: consent ? 1 : 0,
    ontario: ontario ? 1 : 0,
    expiresAt,
    expiresAtMs: new Date(expiresAt).getTime(),
  });
}

export function takeOAuthState(state) {
  const now = Date.now();
  prune(states, now);
  if (!state) return null;
  const row = states.get(state);
  if (!row) return null;
  states.delete(state);
  if (!(row.expiresAtMs > now)) return null;
  return row;
}

export function saveOAuthCode({ code, riderId, isNew, expiresAt }) {
  const now = Date.now();
  prune(states, now);
  prune(codes, now);
  remember(codes, code, {
    rider_id: riderId,
    is_new: isNew ? 1 : 0,
    expiresAt,
    expiresAtMs: new Date(expiresAt).getTime(),
  });
}

export function takeOAuthCode(code) {
  const now = Date.now();
  prune(codes, now);
  if (!code) return null;
  const row = codes.get(code);
  if (!row) return null;
  codes.delete(code);
  if (!(row.expiresAtMs > now)) return null;
  return row;
}
