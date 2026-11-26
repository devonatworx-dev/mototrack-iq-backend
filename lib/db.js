'use strict';

import initSqlJs from 'sql.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { atomicWriteFile, createSerializer } from './atomic-file.js';
import { GRANDFATHERED_UNLIMITED_PLANS, PASS_SPECS, normalizeSessionDay } from './pricing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DB location: prefer DB_PATH env (points at a persistent Railway volume in prod),
// fall back to the local ./data dir for development. Ensures the parent dir exists
// so a freshly-mounted empty volume works on first boot.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mototrackiq.db');
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch { /* ignore */ }

let _db = null;
let _SQL = null;

// ── Initialize ──────────────────────────────────────────────────────────────

export async function initDb() {
  _SQL = await initSqlJs();
  let db;

  // Load only DB_PATH. Files in the backup directory are never substituted
  // for this file; restoring an older copy is a manual step (see README).
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new _SQL.Database(fileBuffer);
  } else {
    db = new _SQL.Database();
  }

  // Create schema
  db.run(`
    CREATE TABLE IF NOT EXISTS riders (
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
      marketingConsent INTEGER NOT NULL DEFAULT 0,
      marketingConsentAt TEXT,
      marketingConsentSource TEXT,
      ontarioAttestedAt TEXT,
      plan TEXT,
      resetToken TEXT,
      resetTokenExpiry TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);

  // Add reset columns if they don't exist (for existing DBs)
  try {
    db.run(`ALTER TABLE riders ADD COLUMN resetToken TEXT`);
  } catch (_) {}
  try {
    db.run(`ALTER TABLE riders ADD COLUMN resetTokenExpiry TEXT`);
  } catch (_) {}
  // Verification-first flow columns (for existing DBs)
  try { db.run(`ALTER TABLE riders ADD COLUMN verifyTokenExpiry TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE riders ADD COLUMN consentAt TEXT`); } catch (_) {}
  // Territory safeguard: records when a rider attested Ontario residency at signup.
  try { db.run(`ALTER TABLE riders ADD COLUMN ontarioAttestedAt TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE riders ADD COLUMN lapTimer TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE riders ADD COLUMN plan TEXT`); } catch (_) {}
  // Marketing consent is separate from consentAt (account confirmation).
  // Existing riders were opted in by the verification email; that is not
  // express consent, so the new column defaults to 0 and is not backfilled.
  try { db.run(`ALTER TABLE riders ADD COLUMN marketingConsent INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  try { db.run(`ALTER TABLE riders ADD COLUMN marketingConsentAt TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE riders ADD COLUMN marketingConsentSource TEXT`); } catch (_) {}

  // ── Credit / entitlement columns (P1 monetization) ─────────────────────────
  // reportCredits: flexible credits (signup, Single Report, promo, admin).
  //   Every new account starts with 1. Event and Season passes are pass_grants,
  //   not extra flexible credits. plan='season'/'pro' remains grandfathered unlimited.
  // reportsGenerated: lifetime count of sessions paid for (analytics + the
  //   "ask for a review after the first report" trigger). PDF regen does not increment.
  // When the reportCredits column is first added, existing verified riders predate
  //   the credit system — grant them their 1 free credit as a one-time backfill.
  let reportCreditsIsNew = false;
  try { db.run(`ALTER TABLE riders ADD COLUMN reportCredits INTEGER DEFAULT 1`); reportCreditsIsNew = true; } catch (_) {}
  try { db.run(`ALTER TABLE riders ADD COLUMN reportsGenerated INTEGER DEFAULT 0`); } catch (_) {}
  if (reportCreditsIsNew) {
    // Backfill: give every pre-existing rider exactly 1 free credit to start.
    try { db.run(`UPDATE riders SET reportCredits = 1 WHERE reportCredits IS NULL`); } catch (_) {}
  }

  // Social sign-in. Additive and idempotent: CREATE TABLE IF NOT EXISTS only.
  // Existing password riders, password hashes, and beta_signups rows are not
  // rewritten. oauth_identities attaches Google/Microsoft (and later Facebook)
  // to the same rider without replacing riders.passwordHash or riders.email.
  // oauth_states and oauth_codes stay so an existing file is not rewritten,
  // but the request path does not insert into them. In-flight state and the
  // portal code live in memory (lib/oauth-handoff.js).
  db.run(`
    CREATE TABLE IF NOT EXISTS oauth_identities (
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      rider_id TEXT NOT NULL,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      PRIMARY KEY (provider, provider_user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      verifier TEXT,
      consent INTEGER NOT NULL DEFAULT 0,
      ontario INTEGER NOT NULL DEFAULT 0,
      expiresAt TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code TEXT PRIMARY KEY,
      rider_id TEXT NOT NULL,
      is_new INTEGER NOT NULL DEFAULT 0,
      expiresAt TEXT NOT NULL
    )
  `);

  // Migration: make riders.passwordHash NULLABLE for the verification-first flow.
  // Older DBs created the column as `passwordHash TEXT NOT NULL`, which blocks
  // pending (pre-password) accounts. SQLite can't ALTER a column's constraint, so
  // rebuild the table only when the NOT NULL constraint is still present.
  try {
    const info = db.exec(`PRAGMA table_info(riders)`);
    let pwdNotNull = false;
    if (info && info[0]) {
      const cols = info[0].columns;              // ['cid','name','type','notnull','dflt_value','pk']
      const nameI = cols.indexOf('name');
      const nnI = cols.indexOf('notnull');
      for (const row of info[0].values) {
        if (row[nameI] === 'passwordHash' && Number(row[nnI]) === 1) { pwdNotNull = true; break; }
      }
    }
    if (pwdNotNull) {
      db.run('BEGIN TRANSACTION');
      db.run(`
        CREATE TABLE riders_new (
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
          notes TEXT,
          verified INTEGER DEFAULT 0,
          verifyToken TEXT,
          verifyTokenExpiry TEXT,
          consentAt TEXT,
          plan TEXT,
          resetToken TEXT,
          resetTokenExpiry TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `);
      db.run(`
        INSERT INTO riders_new (id, firstName, lastName, email, phone, passwordHash, experience, riderType, bikes, primaryTrack, notes, verified, verifyToken, verifyTokenExpiry, consentAt, plan, resetToken, resetTokenExpiry, createdAt, updatedAt)
        SELECT id, firstName, lastName, email, phone, passwordHash, experience, riderType, bikes, primaryTrack, notes, verified, verifyToken, verifyTokenExpiry, consentAt, plan, resetToken, resetTokenExpiry, createdAt, updatedAt FROM riders
      `);
      db.run(`DROP TABLE riders`);
      db.run(`ALTER TABLE riders_new RENAME TO riders`);
      db.run('COMMIT');
      console.log('[db] migrated riders.passwordHash to NULLABLE');
    }
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    console.error('[db] passwordHash nullable migration failed:', e.message);
  }

  // Re-apply after the nullable-password rebuild, which recreates riders
  // without columns added above it.
  try { db.run(`ALTER TABLE riders ADD COLUMN marketingConsent INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  try { db.run(`ALTER TABLE riders ADD COLUMN marketingConsentAt TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE riders ADD COLUMN marketingConsentSource TEXT`); } catch (_) {}
  // One-time signup credit. Existing riders already received it via reportCredits.
  // Flag them without adding another credit and without touching updatedAt.
  // Placed after the password rebuild so that rebuild cannot drop the column.
  let signupCreditIsNew = false;
  try {
    db.run(`ALTER TABLE riders ADD COLUMN signupCreditGranted INTEGER NOT NULL DEFAULT 0`);
    signupCreditIsNew = true;
  } catch (_) {}
  if (signupCreditIsNew) {
    try { db.run(`UPDATE riders SET signupCreditGranted = 1`); } catch (_) {}
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      riderId TEXT,
      deviceName TEXT,
      riderName TEXT,
      slotId TEXT,
      name TEXT,
      track TEXT,
      bike TEXT,
      date TEXT,
      csvContent TEXT,
      analysisData TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (riderId) REFERENCES riders(id) ON DELETE CASCADE
    )
  `);

  // Add device columns to existing DBs
  try { db.run(`ALTER TABLE sessions ADD COLUMN deviceName TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE sessions ADD COLUMN riderName TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE sessions ADD COLUMN slotId TEXT`); } catch (_) {}
  // 1 once the session has been paid for. PDF regen of a paid session is free.
  // Sessions already stored were charged at upload, so the first time this
  // column appears they are marked paid. Later boots do not run the backfill.
  let creditConsumedIsNew = false;
  try {
    db.run(`ALTER TABLE sessions ADD COLUMN creditConsumed INTEGER NOT NULL DEFAULT 0`);
    creditConsumedIsNew = true;
  } catch (_) {}
  if (creditConsumedIsNew) {
    try { db.run(`UPDATE sessions SET creditConsumed = 1`); } catch (_) {}
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS beta_signups (
      id TEXT PRIMARY KEY,
      firstName TEXT NOT NULL,
      lastName TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      bike TEXT,
      track TEXT,
      experience TEXT,
      source TEXT,
      consent INTEGER NOT NULL,
      marketingConsent INTEGER NOT NULL DEFAULT 0,
      confirmed INTEGER DEFAULT 0,
      confirmToken TEXT,
      confirmedAt TEXT,
      submittedAt TEXT,
      ip TEXT,
      createdAt TEXT NOT NULL
    )
  `);

  // Double opt-in columns for existing beta_signups DBs.
  // When the `confirmed` column is first added, existing signups predate double
  // opt-in — they're already trusted, so backfill them to confirmed=1 (one-time)
  // rather than forcing existing waitlisters to re-confirm.
  let betaConfirmedIsNew = false;
  try { db.run(`ALTER TABLE beta_signups ADD COLUMN confirmed INTEGER DEFAULT 0`); betaConfirmedIsNew = true; } catch (_) {}
  try { db.run(`ALTER TABLE beta_signups ADD COLUMN confirmToken TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE beta_signups ADD COLUMN confirmedAt TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE beta_signups ADD COLUMN confirmTokenExpiry TEXT`); } catch (_) {}
  // Conversion tracking: when an admin promotes a waitlist signup to a full rider account.
  try { db.run(`ALTER TABLE beta_signups ADD COLUMN converted INTEGER DEFAULT 0`); } catch (_) {}
  try { db.run(`ALTER TABLE beta_signups ADD COLUMN convertedAt TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE beta_signups ADD COLUMN convertedRiderId TEXT`); } catch (_) {}
  if (betaConfirmedIsNew) {
    try { db.run(`UPDATE beta_signups SET confirmed = 1, confirmedAt = createdAt WHERE confirmed = 0`); } catch (_) {}
  }

  // Append-only CASL record. granted=1 is express opt-in; granted=0 is a
  // refusal or a withdrawal. source is where that choice was recorded.
  db.run(`
    CREATE TABLE IF NOT EXISTS marketing_consent_records (
      id TEXT PRIMARY KEY,
      riderId TEXT,
      email TEXT NOT NULL,
      granted INTEGER NOT NULL,
      source TEXT NOT NULL,
      recordedAt TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_marketing_consent_email ON marketing_consent_records(email)`);

  // Legacy waitlist rows predate a separate, optional marketing opt-in.
  // The first time the column appears, force them off and write a record so
  // no commercial send can treat the old waitlist checkbox as consent.
  let betaMarketingIsNew = false;
  try {
    db.run(`ALTER TABLE beta_signups ADD COLUMN marketingConsent INTEGER NOT NULL DEFAULT 0`);
    betaMarketingIsNew = true;
  } catch (_) {}
  if (betaMarketingIsNew) {
    try { db.run(`UPDATE beta_signups SET marketingConsent = 0`); } catch (_) {}
    try {
      const found = db.exec(`SELECT email FROM beta_signups`);
      const emails = found[0]?.values || [];
      const now = new Date().toISOString();
      for (const [email] of emails) {
        if (!email) continue;
        const norm = String(email).trim().toLowerCase();
        db.run(
          `INSERT INTO marketing_consent_records (id, riderId, email, granted, source, recordedAt) VALUES (?, NULL, ?, 0, 'legacy_beta', ?)`,
          [crypto.randomUUID(), norm, now]
        );
      }
    } catch (e) {
      console.error('[db] legacy beta marketing opt-out failed:', e.message);
    }
  }

  // ── Promo codes (P1b monetization) ─────────────────────────────────────────
  // A controllable credit-grant lever: Everett hands out codes (early-access,
  // partners, launch, refer-a-friend). Redeeming a valid code tops up a verified
  // rider's reportCredits. Redemptions are tracked per-rider so a single code
  // can't be reused by the same account (enforced in redeemPromoCode()).
  db.run(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      creditsGranted INTEGER NOT NULL DEFAULT 1,
      maxUses INTEGER,
      usedCount INTEGER NOT NULL DEFAULT 0,
      expiresAt TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      createdAt TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      riderId TEXT NOT NULL,
      creditsGranted INTEGER NOT NULL,
      redeemedAt TEXT NOT NULL,
      UNIQUE(code, riderId)
    )
  `);

  // Rider feedback / reviews. Collected in-app after a report is generated.
  // Private by default; `approved` (admin-set) gates whether it may appear in
  // the public testimonials endpoint. `consentPublic` records that the rider
  // agreed we may feature their words publicly (double gate: consent + approval).
  db.run(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      riderId TEXT,
      riderName TEXT,
      email TEXT,
      rating INTEGER,
      comment TEXT,
      consentPublic INTEGER NOT NULL DEFAULT 0,
      approved INTEGER NOT NULL DEFAULT 0,
      featured INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      createdAt TEXT NOT NULL,
      reviewedAt TEXT
    )
  `);

  // ── Processed LemonSqueezy orders (idempotency ledger) ──────────────────────
  // Records every order webhook we've acted on so a duplicate/retried delivery
  // never grants credits twice. status: granted | duplicate | unmatched | rider_missing.
  db.run(`
    CREATE TABLE IF NOT EXISTS processed_orders (
      orderId TEXT PRIMARY KEY,
      riderId TEXT,
      productKey TEXT,
      status TEXT NOT NULL,
      processedAt TEXT NOT NULL
    )
  `);

  // Event Pass and Season Pass balances. Flexible credits stay on
  // riders.reportCredits. Additive: an existing file gains empty tables.
  db.run(`
    CREATE TABLE IF NOT EXISTS pass_grants (
      id TEXT PRIMARY KEY,
      riderId TEXT NOT NULL,
      kind TEXT NOT NULL,
      creditsTotal INTEGER NOT NULL,
      creditsRemaining INTEGER NOT NULL,
      dailyCap INTEGER NOT NULL,
      maxDays INTEGER NOT NULL,
      boundDate TEXT,
      orderId TEXT,
      createdAt TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pass_grants_rider ON pass_grants(riderId, kind)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS pass_uses (
      id TEXT PRIMARY KEY,
      grantId TEXT NOT NULL,
      riderId TEXT NOT NULL,
      sessionId TEXT,
      sessionDate TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pass_uses_grant_day ON pass_uses(grantId, sessionDate)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pass_uses_session ON pass_uses(sessionId)`);

  _db = db;
  return db;
}

const saveExclusive = createSerializer();

function saveDb() {
  if (!_db) return;
  // Every mutation still saves immediately. The serializer collapses a
  // re-entrant save into one follow-up write so two saves never overlap.
  saveExclusive(() => {
    const data = Buffer.from(_db.export());
    atomicWriteFile(DB_PATH, data);
  });
}

export function persistDb() {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  saveDb();
}

export function getDbFilePath() {
  return DB_PATH;
}

function getDb() {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

// ── Helper: row to object ────────────────────────────────────────────────────

function rowToObj(columns, values) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[i]; });
  return obj;
}

function queryOne(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = rowToObj(stmt.getColumnNames(), stmt.get());
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function queryAll(sql, params = []) {
  const db = getDb();
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(rowToObj(stmt.getColumnNames(), stmt.get()));
  }
  stmt.free();
  return results;
}

function run(sql, params = []) {
  const db = getDb();
  db.run(sql, params);
  saveDb();
}

// ── Rider functions ──────────────────────────────────────────────────────────

export function createRider({ id, firstName, lastName, email, phone, passwordHash, experience, riderType, bikes, primaryTrack, lapTimer, notes, verifyToken, verifyTokenExpiry, consentAt, ontarioAttestedAt }) {
  const now = new Date().toISOString();
  run(`
    INSERT INTO riders (id, firstName, lastName, email, phone, passwordHash, experience, riderType, bikes, primaryTrack, lapTimer, notes, verified, verifyToken, verifyTokenExpiry, consentAt, ontarioAttestedAt, reportCredits, signupCreditGranted, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, 1, ?, ?)
  `, [id, firstName, lastName, email, phone || null, passwordHash || null, experience || null, riderType || null, bikes || null, primaryTrack || null, lapTimer || null, notes || null, verifyToken || null, verifyTokenExpiry || null, consentAt || null, ontarioAttestedAt || null, now, now]);
  return getRiderByEmail(email);
}

export function getRiderByEmail(email) {
  return queryOne('SELECT * FROM riders WHERE email = ?', [email]);
}

export function getRiderById(id) {
  return queryOne('SELECT * FROM riders WHERE id = ?', [id]);
}

export function getRiderByResetToken(token) {
  return queryOne('SELECT * FROM riders WHERE resetToken = ? AND resetTokenExpiry > ?', [token, new Date().toISOString()]);
}

export function getRiderByVerifyToken(token) {
  return queryOne('SELECT * FROM riders WHERE verifyToken = ?', [token]);
}

export function updateRider(id, updates) {
  const now = new Date().toISOString();
  const allowed = ['firstName', 'lastName', 'phone', 'experience', 'riderType', 'bikes', 'primaryTrack', 'lapTimer', 'notes', 'verified', 'passwordHash', 'verifyToken', 'verifyTokenExpiry', 'consentAt', 'plan', 'resetToken', 'resetTokenExpiry', 'reportCredits', 'reportsGenerated', 'signupCreditGranted'];
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  fields.push('updatedAt = ?');
  values.push(now);
  values.push(id);
  run(`UPDATE riders SET ${fields.join(', ')} WHERE id = ?`, values);
  return getRiderById(id);
}

// Not used on the request path. Kept so a database that already has these
// tables can still be inspected. Live handoff is lib/oauth-handoff.js.
export function saveOAuthState({ state, provider, verifier, consent, ontario, expiresAt }) {
  run(
    `INSERT INTO oauth_states (state, provider, verifier, consent, ontario, expiresAt) VALUES (?, ?, ?, ?, ?, ?)`,
    [state, provider, verifier || '', consent ? 1 : 0, ontario ? 1 : 0, expiresAt],
  );
}

export function takeOAuthState(state) {
  if (!state) return null;
  const row = queryOne('SELECT * FROM oauth_states WHERE state = ?', [state]);
  if (!row) return null;
  run('DELETE FROM oauth_states WHERE state = ?', [state]);
  if (!row.expiresAt || new Date(row.expiresAt) < new Date()) return null;
  return row;
}

export function getOAuthIdentity(provider, providerUserId) {
  return queryOne(
    'SELECT * FROM oauth_identities WHERE provider = ? AND provider_user_id = ?',
    [provider, providerUserId],
  );
}

export function attachOAuthIdentity({ provider, providerUserId, riderId, email, emailVerified }) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO oauth_identities (provider, provider_user_id, rider_id, email, email_verified, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [provider, providerUserId, riderId, email || null, emailVerified ? 1 : 0, now],
  );
  return getOAuthIdentity(provider, providerUserId);
}

export function saveOAuthCode({ code, riderId, isNew, expiresAt }) {
  run(
    `INSERT INTO oauth_codes (code, rider_id, is_new, expiresAt) VALUES (?, ?, ?, ?)`,
    [code, riderId, isNew ? 1 : 0, expiresAt],
  );
}

export function takeOAuthCode(code) {
  if (!code) return null;
  const row = queryOne('SELECT * FROM oauth_codes WHERE code = ?', [code]);
  if (!row) return null;
  run('DELETE FROM oauth_codes WHERE code = ?', [code]);
  if (!row.expiresAt || new Date(row.expiresAt) < new Date()) return null;
  return row;
}

// ── Credit / entitlement ────────────────────────────────────────────────
// Day-scoped passes live in pass_grants. Flexible credits stay on
// riders.reportCredits. See lib/pricing.js for which grant pays for a session.
// Grandfathered unlimited is riders.plan of 'season' or 'pro' already stored.
// New Season Pass purchases do not set that plan.

function countUses(grantId, day) {
  const row = queryOne(
    'SELECT COUNT(*) AS n FROM pass_uses WHERE grantId = ? AND sessionDate = ?',
    [grantId, day],
  );
  return Number(row?.n || 0);
}

function countDays(grantId) {
  const row = queryOne(
    'SELECT COUNT(DISTINCT sessionDate) AS n FROM pass_uses WHERE grantId = ?',
    [grantId],
  );
  return Number(row?.n || 0);
}

function grantDays(grantId) {
  return queryAll(
    'SELECT DISTINCT sessionDate AS d FROM pass_uses WHERE grantId = ? ORDER BY sessionDate',
    [grantId],
  ).map((row) => row.d);
}

function eventUsable(grant) {
  if (Number(grant.creditsRemaining) <= 0) return false;
  if (!grant.boundDate) return true;
  return countUses(grant.id, grant.boundDate) < Number(grant.dailyCap);
}

function seasonUsable(grant) {
  if (Number(grant.creditsRemaining) <= 0) return false;
  if (countDays(grant.id) < Number(grant.maxDays)) return true;
  const rows = queryAll(
    'SELECT sessionDate, COUNT(*) AS n FROM pass_uses WHERE grantId = ? GROUP BY sessionDate',
    [grant.id],
  );
  return rows.some((row) => Number(row.n) < Number(grant.dailyCap));
}

function loadPasses(riderId) {
  const grants = queryAll(
    'SELECT * FROM pass_grants WHERE riderId = ? ORDER BY createdAt ASC, id ASC',
    [riderId],
  );
  return {
    event: grants.filter((g) => g.kind === 'event'),
    season: grants.filter((g) => g.kind === 'season'),
  };
}

function isGrandfathered(rider) {
  return GRANDFATHERED_UNLIMITED_PLANS.includes(rider?.plan);
}

export function getEntitlement(riderId) {
  const r = getRiderById(riderId);
  if (!r) return null;
  const grandfathered = isGrandfathered(r);
  const flex = Number(r.reportCredits ?? 0);
  const { event, season } = loadPasses(riderId);
  const eventDates = [...new Set(event.map((g) => g.boundDate).filter(Boolean))];
  const seasonHolder = grandfathered || season.length > 0;
  const canGenerate = grandfathered || flex > 0 || event.some(eventUsable) || season.some(seasonUsable);
  return {
    riderId: r.id,
    plan: r.plan || 'free',
    unlimited: grandfathered,
    grandfatheredUnlimited: grandfathered,
    reportCredits: flex,
    reportsGenerated: Number(r.reportsGenerated ?? 0),
    canGenerate,
    dayReport: {
      included: seasonHolder || eventDates.length > 0,
      season: seasonHolder,
      anyDate: seasonHolder,
      eventDates,
    },
    passes: {
      event: event.map((g) => ({
        id: g.id,
        creditsRemaining: Number(g.creditsRemaining),
        creditsTotal: Number(g.creditsTotal),
        dailyCap: Number(g.dailyCap),
        maxDays: Number(g.maxDays),
        boundDate: g.boundDate || null,
      })),
      season: season.map((g) => ({
        id: g.id,
        creditsRemaining: Number(g.creditsRemaining),
        creditsTotal: Number(g.creditsTotal),
        dailyCap: Number(g.dailyCap),
        maxDays: Number(g.maxDays),
        daysUsed: countDays(g.id),
        days: grantDays(g.id),
      })),
    },
  };
}

// Idempotent. createRider already records the free credit. Calling this again,
// or calling it when an email account is later linked to OAuth, does not add one.
export function grantSignupCreditOnce(riderId) {
  const r = getRiderById(riderId);
  if (!r) return null;
  if (Number(r.signupCreditGranted) === 1) return getEntitlement(riderId);
  const now = new Date().toISOString();
  run(
    `UPDATE riders
        SET reportCredits = COALESCE(reportCredits, 0) + 1,
            signupCreditGranted = 1,
            updatedAt = ?
      WHERE id = ? AND COALESCE(signupCreditGranted, 0) = 0`,
    [now, riderId],
  );
  return getEntitlement(riderId);
}

// One Event Pass or Season Pass per unit of quantity. Each grant has its own
// day cap. quantity 2 is two passes, not one pass with doubled credits.
export function grantPass(riderId, kind, { quantity = 1, orderId = null } = {}) {
  const spec = PASS_SPECS[kind];
  if (!spec) throw new Error(`Unknown pass: ${kind}`);
  const n = Math.max(1, parseInt(quantity, 10) || 1);
  const now = new Date().toISOString();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    run(
      `INSERT INTO pass_grants
        (id, riderId, kind, creditsTotal, creditsRemaining, dailyCap, maxDays, boundDate, orderId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [id, riderId, kind, spec.credits, spec.credits, spec.dailyCap, spec.maxDays, orderId || null, now],
    );
    ids.push(id);
  }
  return ids;
}

// Read-only choice of which balance would pay for a session on this day.
function selectCharge(rider, day) {
  if (isGrandfathered(rider)) return { ok: true, source: 'unlimited' };

  const flex = Number(rider.reportCredits ?? 0);
  const { event, season } = loadPasses(rider.id);

  if (!day) {
    if (flex > 0) return { ok: true, source: 'flex' };
    const passLeft = [...event, ...season].some((g) => Number(g.creditsRemaining) > 0);
    if (passLeft) return { ok: false, code: 'session_date_required' };
    return { ok: false, code: 'out_of_credits' };
  }

  for (const g of event) {
    if (g.boundDate === day && eventUsable(g)) {
      return { ok: true, source: 'event', grant: g, bind: false };
    }
  }

  let seasonDayFull = false;
  let seasonDaysFull = false;
  let seasonCoversThisDay = false;
  for (const g of season) {
    if (Number(g.creditsRemaining) <= 0) continue;
    const usedToday = countUses(g.id, day);
    if (usedToday > 0) seasonCoversThisDay = true;
    if (usedToday >= Number(g.dailyCap)) {
      seasonDayFull = true;
      continue;
    }
    if (usedToday === 0 && countDays(g.id) >= Number(g.maxDays)) {
      seasonDaysFull = true;
      continue;
    }
    return { ok: true, source: 'season', grant: g, bind: false };
  }

  // Do not bind a fresh Event Pass onto a Season day that is already at 6.
  // That 7th session is a Single Report. A new calendar day still can.
  if (!seasonCoversThisDay) {
    for (const g of event) {
      if (!g.boundDate && Number(g.creditsRemaining) > 0) {
        return { ok: true, source: 'event', grant: g, bind: true };
      }
    }
  }

  if (flex > 0) return { ok: true, source: 'flex' };

  const eventDayFull = event.some((g) => g.boundDate === day && countUses(g.id, day) >= Number(g.dailyCap));
  if (seasonDayFull || eventDayFull) return { ok: false, code: 'daily_session_cap' };
  if (seasonDaysFull) return { ok: false, code: 'season_days_exhausted' };
  const locked = event.find((g) => g.boundDate && g.boundDate !== day && Number(g.creditsRemaining) > 0);
  if (locked) return { ok: false, code: 'event_day_locked', boundDate: locked.boundDate };
  return { ok: false, code: 'out_of_credits' };
}

function bumpGenerated(riderId) {
  const now = new Date().toISOString();
  run(
    `UPDATE riders SET reportsGenerated = COALESCE(reportsGenerated, 0) + 1, updatedAt = ? WHERE id = ?`,
    [now, riderId],
  );
}

function rememberPaid(sessionId) {
  if (!sessionId) return;
  run('UPDATE sessions SET creditConsumed = 1 WHERE id = ?', [sessionId]);
}

export function planSessionCharge(riderId, sessionDate) {
  const rider = getRiderById(riderId);
  if (!rider) return { ok: false, code: 'rider_missing', entitlement: null };
  const day = normalizeSessionDay(sessionDate);
  const selected = selectCharge(rider, day);
  return { ...selected, grant: undefined, sessionDate: day, entitlement: getEntitlement(riderId) };
}

export function consumeSessionCredit(riderId, { sessionDate, sessionId } = {}) {
  const rider = getRiderById(riderId);
  if (!rider) return { ok: false, code: 'rider_missing', entitlement: null };

  if (sessionId) {
    const session = queryOne('SELECT creditConsumed FROM sessions WHERE id = ?', [sessionId]);
    if (session && Number(session.creditConsumed) === 1) {
      return { ok: true, source: 'already', duplicate: true, entitlement: getEntitlement(riderId) };
    }
    const prior = queryOne('SELECT id, grantId FROM pass_uses WHERE sessionId = ?', [sessionId]);
    if (prior) {
      rememberPaid(sessionId);
      return {
        ok: true,
        source: 'already',
        duplicate: true,
        grantId: prior.grantId,
        useId: prior.id,
        entitlement: getEntitlement(riderId),
      };
    }
  }

  const day = normalizeSessionDay(sessionDate);
  const selected = selectCharge(rider, day);
  if (!selected.ok) return { ...selected, entitlement: getEntitlement(riderId) };

  if (selected.source === 'unlimited') {
    bumpGenerated(riderId);
    rememberPaid(sessionId);
    return { ok: true, source: 'unlimited', sessionDate: day, entitlement: getEntitlement(riderId) };
  }

  if (selected.source === 'flex') {
    const now = new Date().toISOString();
    run(
      `UPDATE riders
          SET reportCredits = reportCredits - 1,
              reportsGenerated = COALESCE(reportsGenerated, 0) + 1,
              updatedAt = ?
        WHERE id = ? AND COALESCE(reportCredits, 0) > 0`,
      [now, riderId],
    );
    const after = getRiderById(riderId);
    if (Number(after?.reportCredits) !== Number(rider.reportCredits) - 1) {
      return { ok: false, code: 'out_of_credits', entitlement: getEntitlement(riderId) };
    }
    rememberPaid(sessionId);
    return { ok: true, source: 'flex', sessionDate: day, entitlement: getEntitlement(riderId) };
  }

  const now = new Date().toISOString();
  const useId = crypto.randomUUID();
  if (selected.bind) {
    run(
      'UPDATE pass_grants SET boundDate = ?, creditsRemaining = creditsRemaining - 1 WHERE id = ?',
      [day, selected.grant.id],
    );
  } else {
    run(
      'UPDATE pass_grants SET creditsRemaining = creditsRemaining - 1 WHERE id = ?',
      [selected.grant.id],
    );
  }
  run(
    `INSERT INTO pass_uses (id, grantId, riderId, sessionId, sessionDate, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [useId, selected.grant.id, riderId, sessionId || null, day, now],
  );
  bumpGenerated(riderId);
  rememberPaid(sessionId);
  return {
    ok: true,
    source: selected.source,
    grantId: selected.grant.id,
    useId,
    sessionDate: day,
    entitlement: getEntitlement(riderId),
  };
}

// Compatibility wrapper. Prefer consumeSessionCredit, which reports the denial code.
export function consumeReportCredit(riderId, opts = {}) {
  const result = consumeSessionCredit(riderId, opts);
  if (!result.ok) return null;
  return result.entitlement;
}

export function dayReportAccess(riderId, date) {
  const ent = getEntitlement(riderId);
  if (!ent) return { ok: false, code: 'rider_missing', entitlement: null };
  if (ent.dayReport.anyDate) return { ok: true, entitlement: ent };
  const day = normalizeSessionDay(date);
  if (day && ent.dayReport.eventDates.includes(day)) return { ok: true, entitlement: ent };
  return { ok: false, code: 'day_report_not_included', entitlement: ent };
}

// Undo one consumeSessionCredit. Used when a one-shot report email is not delivered.
export function refundSessionCredit(riderId, charge) {
  if (!charge?.ok || charge.duplicate || charge.source === 'already') return getEntitlement(riderId);
  const now = new Date().toISOString();
  const undoCount = `reportsGenerated = CASE WHEN COALESCE(reportsGenerated, 0) > 0 THEN reportsGenerated - 1 ELSE 0 END`;
  if (charge.source === 'flex') {
    run(
      `UPDATE riders SET reportCredits = COALESCE(reportCredits, 0) + 1, ${undoCount}, updatedAt = ? WHERE id = ?`,
      [now, riderId],
    );
  } else if (charge.source === 'event' || charge.source === 'season') {
    if (charge.useId) run('DELETE FROM pass_uses WHERE id = ?', [charge.useId]);
    if (charge.grantId) {
      run('UPDATE pass_grants SET creditsRemaining = creditsRemaining + 1 WHERE id = ?', [charge.grantId]);
      const left = queryOne('SELECT COUNT(*) AS n FROM pass_uses WHERE grantId = ?', [charge.grantId]);
      if (Number(left?.n || 0) === 0) {
        run(`UPDATE pass_grants SET boundDate = NULL WHERE id = ? AND kind = 'event'`, [charge.grantId]);
      }
    }
    run(`UPDATE riders SET ${undoCount}, updatedAt = ? WHERE id = ?`, [now, riderId]);
  } else if (charge.source === 'unlimited') {
    run(`UPDATE riders SET ${undoCount}, updatedAt = ? WHERE id = ?`, [now, riderId]);
  }
  return getEntitlement(riderId);
}

// Add flexible credits (promo, admin grant, Single Report). Not a day-scoped pass.
export function addReportCredits(riderId, amount) {
  const n = Math.max(0, parseInt(amount, 10) || 0);
  if (n === 0) return getEntitlement(riderId);
  const now = new Date().toISOString();
  run(`UPDATE riders SET reportCredits = COALESCE(reportCredits, 0) + ?, updatedAt = ? WHERE id = ?`, [n, now, riderId]);
  return getEntitlement(riderId);
}

// ── Processed-order idempotency (LemonSqueezy webhooks) ────────────────────

export function hasProcessedOrder(orderId) {
  if (!orderId) return false;
  const row = queryOne('SELECT orderId FROM processed_orders WHERE orderId = ?', [String(orderId)]);
  return Boolean(row);
}

export function recordProcessedOrder(orderId, riderId, productKey, status) {
  if (!orderId) return;
  const now = new Date().toISOString();
  try {
    run(`INSERT OR IGNORE INTO processed_orders (orderId, riderId, productKey, status, processedAt)
         VALUES (?, ?, ?, ?, ?)`,
      [String(orderId), riderId ? String(riderId) : null, productKey || null, status || 'granted', now]);
  } catch (e) { console.error('[recordProcessedOrder]', e.message); }
}

// ── Promo code functions (P1b) ─────────────────────────────────────

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

export function createPromoCode({ code, creditsGranted = 1, maxUses = null, expiresAt = null, note = null }) {
  const c = normalizeCode(code);
  if (!c) throw new Error('code required');
  const now = new Date().toISOString();
  run(`INSERT INTO promo_codes (code, creditsGranted, maxUses, usedCount, expiresAt, active, note, createdAt)
       VALUES (?, ?, ?, 0, ?, 1, ?, ?)`,
    [c, Math.max(1, parseInt(creditsGranted, 10) || 1), maxUses != null ? parseInt(maxUses, 10) : null, expiresAt || null, note || null, now]);
  return getPromoCode(c);
}

export function getPromoCode(code) {
  return queryOne('SELECT * FROM promo_codes WHERE code = ?', [normalizeCode(code)]);
}

export function listPromoCodes() {
  return queryAll('SELECT * FROM promo_codes ORDER BY createdAt DESC');
}

export function setPromoActive(code, active) {
  run('UPDATE promo_codes SET active = ? WHERE code = ?', [active ? 1 : 0, normalizeCode(code)]);
  return getPromoCode(code);
}

// Redeem a promo code for a rider. Returns { ok, error?, creditsGranted?, entitlement? }.
// Enforces: exists, active, not expired, under maxUses, and not already redeemed
// by this rider (UNIQUE(code, riderId)). On success: records redemption,
// increments usedCount, and tops up the rider's report credits.
export function redeemPromoCode(riderId, code) {
  const c = normalizeCode(code);
  const promo = getPromoCode(c);
  if (!promo || !promo.active) return { ok: false, error: 'Invalid or inactive promo code' };
  if (promo.expiresAt && new Date(promo.expiresAt).getTime() < Date.now()) {
    return { ok: false, error: 'This promo code has expired' };
  }
  if (promo.maxUses != null && Number(promo.usedCount) >= Number(promo.maxUses)) {
    return { ok: false, error: 'This promo code has reached its usage limit' };
  }
  const already = queryOne('SELECT id FROM promo_redemptions WHERE code = ? AND riderId = ?', [c, riderId]);
  if (already) return { ok: false, error: 'You have already redeemed this code' };

  const now = new Date().toISOString();
  // Record redemption (UNIQUE constraint guards against double-redeem races).
  try {
    run(`INSERT INTO promo_redemptions (id, code, riderId, creditsGranted, redeemedAt) VALUES (?, ?, ?, ?, ?)`,
      [`${c}:${riderId}`, c, riderId, promo.creditsGranted, now]);
  } catch (_) {
    return { ok: false, error: 'You have already redeemed this code' };
  }
  run('UPDATE promo_codes SET usedCount = usedCount + 1 WHERE code = ?', [c]);
  const entitlement = addReportCredits(riderId, promo.creditsGranted);
  return { ok: true, creditsGranted: promo.creditsGranted, entitlement };
}

// ── Session functions ────────────────────────────────────────────────────────

export function createSession({ id, riderId, deviceName, riderName, slotId, name, track, bike, date, csvContent, analysisData }) {
  const now = new Date().toISOString();
  run(`
    INSERT INTO sessions (id, riderId, deviceName, riderName, slotId, name, track, bike, date, csvContent, analysisData, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, riderId || null, deviceName || null, riderName || null, slotId || null, name || null, track || null, bike || null, date || null, csvContent || null, analysisData ? JSON.stringify(analysisData) : null, now]);
  return getSessionByToken(id);
}

export function getSessionByToken(id) {
  const row = queryOne('SELECT * FROM sessions WHERE id = ?', [id]);
  if (row && row.analysisData) row.analysisData = JSON.parse(row.analysisData);
  return row;
}

export function deleteSession(id) {
  run('DELETE FROM sessions WHERE id = ?', [id]);
}

// Admin: list all sessions for a rider (lightweight — omits heavy csvContent/analysisData
// blobs; derives a few summary fields from analysisData for troubleshooting).
export function getRiderSessionsForAdmin(riderId) {
  const rows = queryAll(
    `SELECT id, riderId, deviceName, riderName, slotId, name, track, bike, date, createdAt,
            (csvContent IS NOT NULL AND LENGTH(csvContent) > 0) AS hasCsv,
            (analysisData IS NOT NULL AND LENGTH(analysisData) > 0) AS hasReport,
            analysisData
     FROM sessions WHERE riderId = ? ORDER BY COALESCE(date, createdAt) DESC`,
    [riderId]
  );
  return rows.map(summarizeSessionRow);
}

// Admin: recent sessions across ALL riders (for spotting failures at a glance).
export function getRecentSessions(limit = 100) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const rows = queryAll(
    `SELECT s.id, s.riderId, s.deviceName, s.riderName, s.slotId, s.name, s.track, s.bike,
            s.date, s.createdAt,
            (s.csvContent IS NOT NULL AND LENGTH(s.csvContent) > 0) AS hasCsv,
            (s.analysisData IS NOT NULL AND LENGTH(s.analysisData) > 0) AS hasReport,
            s.analysisData,
            r.firstName AS riderFirstName, r.lastName AS riderLastName, r.email AS riderEmail
     FROM sessions s LEFT JOIN riders r ON r.id = s.riderId
     ORDER BY COALESCE(s.date, s.createdAt) DESC LIMIT ?`,
    [n]
  );
  return rows.map(summarizeSessionRow);
}

// Parse analysisData JSON, pull a small summary (lap count, best lap), drop the heavy blob.
function summarizeSessionRow(row) {
  const { analysisData, hasCsv, hasReport, ...rest } = row;
  let lapCount = null, bestLap = null;
  if (analysisData) {
    try {
      const a = JSON.parse(analysisData);
      if (Array.isArray(a?.laps)) {
        lapCount = a.laps.length;
        const times = a.laps.map(l => l?.time).filter(t => typeof t === 'number' && t > 0);
        if (times.length) bestLap = Math.min(...times);
      }
    } catch { /* ignore malformed analysisData */ }
  }
  return { ...rest, hasCsv: !!hasCsv, hasReport: !!hasReport, lapCount, bestLap };
}

/**
 * Persist a modified analysisData blob for a session.
 *
 * Used by the legacy track-map backfill: sessions uploaded before the
 * analyzer started emitting `visualizations.trackMap` have no map in their
 * stored analysis, so their PDFs render without the speed-heat racing line.
 * The stored CSV is still on the session, so the map can be regenerated
 * from it and written back once, permanently fixing the session.
 *
 * @param {string} id      session id
 * @param {object} analysis full analysisData object (serialized here)
 * @returns {object|null} the updated session, or null if the id is unknown
 */
export function updateSessionAnalysis(id, analysis) {
  if (!id || !analysis || typeof analysis !== 'object') return null;
  run('UPDATE sessions SET analysisData = ? WHERE id = ?', [JSON.stringify(analysis), id]);
  return getSessionByToken(id);
}

export function updateSession(id, fields) {
  const allowed = ['name', 'track', 'bike', 'date', 'deviceName', 'riderName', 'slotId'];
  const updates = [];
  const values = [];
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (!updates.length) return getSessionByToken(id);
  values.push(id);
  run(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`, values);
  return getSessionByToken(id);
}

export function cleanExpiredSessions() {
  // No expiry column in current schema
}

export function createSessionData({ id, riderId, name, track, bike, date, csvContent, analysisData }) {
  return createSession({ id, riderId, name, track, bike, date, csvContent, analysisData });
}

export function getSessionsByRider(riderId) {
  const rows = queryAll('SELECT * FROM sessions WHERE riderId = ? ORDER BY createdAt DESC', [riderId]);
  return rows.map(row => {
    if (row.analysisData) row.analysisData = JSON.parse(row.analysisData);
    return row;
  });
}

export function getSessionById(id) {
  return getSessionByToken(id);
}

// ── Beta signup functions ────────────────────────────────────────────────────

export function createBetaSignup({ id, firstName, lastName, email, bike, track, experience, source, consent, marketingConsent = false, confirmToken, confirmTokenExpiry, submittedAt, ip }) {
  const now = new Date().toISOString();
  // `consent` is the historical waitlist checkbox. It is not permission to
  // send commercial email. marketingConsent defaults off.
  run(`
    INSERT OR IGNORE INTO beta_signups (id, firstName, lastName, email, bike, track, experience, source, consent, marketingConsent, confirmed, confirmToken, confirmTokenExpiry, submittedAt, ip, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `, [id, firstName, lastName, email, bike || null, track || null, experience || null, source || null, consent ? 1 : 0, marketingConsent ? 1 : 0, confirmToken || null, confirmTokenExpiry || null, submittedAt || null, ip || null, now]);
  return queryOne('SELECT * FROM beta_signups WHERE email = ?', [email]);
}

export function getBetaSignupByEmail(email) {
  return queryOne('SELECT * FROM beta_signups WHERE email = ?', [email]);
}

export async function migrateLegacyBetaSignups(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    return { migrated: 0 };
  }
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const signups = Array.isArray(data) ? data : (data.signups || []);
    let migrated = 0;
    for (const signup of signups) {
      try {
        const { v4: uuidv4 } = await import('uuid');
        createBetaSignup({
          id: uuidv4(),
          firstName: signup.firstName || signup.first_name || 'Unknown',
          lastName: signup.lastName || signup.last_name || 'Unknown',
          email: signup.email,
          bike: signup.bike || null,
          track: signup.track || null,
          experience: signup.experience || null,
          source: signup.source || 'legacy',
          consent: signup.consent || true,
          marketingConsent: false,
          submittedAt: signup.submittedAt || signup.created_at || null,
          ip: signup.ip || null
        });
        ensureLegacyMarketingOptOut(signup.email);
        migrated++;
      } catch (e) {
        // skip duplicates
      }
    }
    return { migrated };
  } catch (e) {
    return { migrated: 0, error: e.message };
  }
}

// ── Feedback / reviews ───────────────────────────────────────────────────────

export function createFeedback({ id, riderId = null, riderName = null, email = null, rating = null, comment = null, consentPublic = 0, source = 'in-app' }) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO feedback (id, riderId, riderName, email, rating, comment, consentPublic, approved, featured, source, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    [id, riderId, riderName, email, rating, comment, consentPublic ? 1 : 0, source, now]
  );
  return queryOne(`SELECT * FROM feedback WHERE id = ?`, [id]);
}

export function getAllFeedback() {
  return queryAll(`SELECT * FROM feedback ORDER BY createdAt DESC`);
}

export function getFeedbackById(id) {
  return queryOne(`SELECT * FROM feedback WHERE id = ?`, [id]);
}

// Public testimonials: only rows the rider consented to publish AND an admin approved.
export function getPublicTestimonials() {
  return queryAll(
    `SELECT id, riderName, rating, comment, featured, createdAt
       FROM feedback
      WHERE approved = 1 AND consentPublic = 1
      ORDER BY featured DESC, createdAt DESC`
  );
}

export function setFeedbackApproval(id, approved) {
  run(`UPDATE feedback SET approved = ?, reviewedAt = ? WHERE id = ?`,
    [approved ? 1 : 0, new Date().toISOString(), id]);
  return getFeedbackById(id);
}

export function setFeedbackFeatured(id, featured) {
  run(`UPDATE feedback SET featured = ? WHERE id = ?`, [featured ? 1 : 0, id]);
  return getFeedbackById(id);
}

export function deleteFeedback(id) {
  run(`DELETE FROM feedback WHERE id = ?`, [id]);
}

export function getAllRiders() {
  return queryAll('SELECT id, firstName, lastName, email, verified, plan, reportCredits, reportsGenerated, consentAt, marketingConsent, marketingConsentAt, marketingConsentSource, ontarioAttestedAt, createdAt FROM riders ORDER BY createdAt DESC');
}

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Case-insensitive lookup. Registration stores a lowercased address; older
// rows may not, and commercial checks must still find them.
export function lookupRiderByEmail(email) {
  const norm = normEmail(email);
  if (!norm) return null;
  return queryOne('SELECT * FROM riders WHERE lower(email) = ?', [norm]);
}

/**
 * Append a consent record and update the rider's current marketing flag.
 * granted false also clears any beta_signups marketing flag for that address.
 * Never turns a legacy beta row on.
 */
export function recordMarketingConsent({ riderId = null, email, granted, source }) {
  const norm = normEmail(email);
  if (!norm) throw new Error('email required');
  if (!source) throw new Error('source required');
  const now = new Date().toISOString();
  const flag = granted ? 1 : 0;
  run(
    `INSERT INTO marketing_consent_records (id, riderId, email, granted, source, recordedAt) VALUES (?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), riderId || null, norm, flag, String(source), now]
  );
  if (riderId) {
    run(
      `UPDATE riders SET marketingConsent = ?, marketingConsentAt = ?, marketingConsentSource = ?, updatedAt = ? WHERE id = ?`,
      [flag, now, String(source), now, riderId]
    );
  }
  if (!flag) {
    run(`UPDATE beta_signups SET marketingConsent = 0 WHERE lower(email) = ?`, [norm]);
  }
  return { riderId: riderId || null, email: norm, granted: flag === 1, source: String(source), recordedAt: now };
}

/**
 * One-click unsubscribe. Updates every current rider for the id or address
 * and writes a granted=0 record. Safe to call more than once.
 */
export function withdrawMarketingConsent({ riderId = null, email = null } = {}) {
  const targets = [];
  if (riderId) {
    const byId = getRiderById(riderId);
    if (byId) targets.push(byId);
  }
  const norm = normEmail(email);
  if (norm) {
    const rows = queryAll('SELECT * FROM riders WHERE lower(email) = ?', [norm]);
    for (const row of rows) {
      if (!targets.some((t) => t.id === row.id)) targets.push(row);
    }
  }
  if (targets.length) {
    for (const rider of targets) {
      recordMarketingConsent({ riderId: rider.id, email: rider.email, granted: false, source: 'unsubscribe' });
    }
    return { ok: true };
  }
  if (norm) {
    recordMarketingConsent({ riderId: null, email: norm, granted: false, source: 'unsubscribe' });
    return { ok: true };
  }
  return { ok: true };
}

export function getMarketingConsentRecords(email) {
  const norm = normEmail(email);
  if (!norm) return [];
  return queryAll(
    `SELECT * FROM marketing_consent_records WHERE email = ? ORDER BY recordedAt ASC`,
    [norm]
  );
}

/** True only when the current rider (or, with no rider, the beta row) has express opt-in. */
export function recipientAllowsMarketing(email) {
  const norm = normEmail(email);
  if (!norm) return false;
  const rider = queryOne('SELECT marketingConsent FROM riders WHERE lower(email) = ?', [norm]);
  if (rider) return Number(rider.marketingConsent) === 1;
  const beta = queryOne('SELECT marketingConsent FROM beta_signups WHERE lower(email) = ?', [norm]);
  if (beta) return Number(beta.marketingConsent) === 1;
  return false;
}

/** The only address list commercial mail may use. Legacy beta contacts are excluded. */
export function listMarketingRecipients() {
  return queryAll(
    `SELECT id, firstName, lastName, email, marketingConsent, marketingConsentAt, marketingConsentSource
     FROM riders WHERE marketingConsent = 1 ORDER BY email`
  );
}

/** Mark one legacy waitlist address as not consented for marketing. */
export function ensureLegacyMarketingOptOut(email) {
  const norm = normEmail(email);
  if (!norm) return;
  run(`UPDATE beta_signups SET marketingConsent = 0 WHERE lower(email) = ?`, [norm]);
  const existing = queryOne(
    `SELECT id FROM marketing_consent_records WHERE email = ? AND source = 'legacy_beta'`,
    [norm]
  );
  if (existing) return;
  const now = new Date().toISOString();
  run(
    `INSERT INTO marketing_consent_records (id, riderId, email, granted, source, recordedAt) VALUES (?, NULL, ?, 0, 'legacy_beta', ?)`,
    [crypto.randomUUID(), norm, now]
  );
}

export function deleteRider(id) {
  run('DELETE FROM pass_uses WHERE riderId = ?', [id]);
  run('DELETE FROM pass_grants WHERE riderId = ?', [id]);
  run('DELETE FROM sessions WHERE riderId = ?', [id]);
  run('DELETE FROM riders WHERE id = ?', [id]);
}
