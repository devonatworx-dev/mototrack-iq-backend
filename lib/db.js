'use strict';

import initSqlJs from 'sql.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

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
  try { db.run(`ALTER TABLE riders ADD COLUMN plan TEXT`); } catch (_) {}

  // ── Credit / entitlement columns (P1 monetization) ─────────────────────────
  // reportCredits: number of full reports the rider may still generate.
  //   Every verified account starts with 1 free credit (the "one free report").
  //   Promo codes and (later) paid plans top this up. Decremented on each full
  //   report generation. When 0 and no active paid plan => paywall.
  // reportsGenerated: lifetime count of full reports produced (analytics + the
  //   "ask for a review after the first report" trigger).
  // When the reportCredits column is first added, existing verified riders predate
  //   the credit system — grant them their 1 free credit as a one-time backfill.
  let reportCreditsIsNew = false;
  try { db.run(`ALTER TABLE riders ADD COLUMN reportCredits INTEGER DEFAULT 1`); reportCreditsIsNew = true; } catch (_) {}
  try { db.run(`ALTER TABLE riders ADD COLUMN reportsGenerated INTEGER DEFAULT 0`); } catch (_) {}
  if (reportCreditsIsNew) {
    // Backfill: give every pre-existing rider exactly 1 free credit to start.
    try { db.run(`UPDATE riders SET reportCredits = 1 WHERE reportCredits IS NULL`); } catch (_) {}
  }

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
  if (betaConfirmedIsNew) {
    try { db.run(`UPDATE beta_signups SET confirmed = 1, confirmedAt = createdAt WHERE confirmed = 0`); } catch (_) {}
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

  _db = db;
  return db;
}

function saveDb() {
  if (!_db) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
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

export function createRider({ id, firstName, lastName, email, phone, passwordHash, experience, riderType, bikes, primaryTrack, notes, verifyToken, verifyTokenExpiry, consentAt, ontarioAttestedAt }) {
  const now = new Date().toISOString();
  run(`
    INSERT INTO riders (id, firstName, lastName, email, phone, passwordHash, experience, riderType, bikes, primaryTrack, notes, verified, verifyToken, verifyTokenExpiry, consentAt, ontarioAttestedAt, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `, [id, firstName, lastName, email, phone || null, passwordHash || null, experience || null, riderType || null, bikes || null, primaryTrack || null, notes || null, verifyToken || null, verifyTokenExpiry || null, consentAt || null, ontarioAttestedAt || null, now, now]);
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
  const allowed = ['firstName', 'lastName', 'phone', 'experience', 'riderType', 'bikes', 'primaryTrack', 'notes', 'verified', 'passwordHash', 'verifyToken', 'verifyTokenExpiry', 'consentAt', 'plan', 'resetToken', 'resetTokenExpiry', 'reportCredits', 'reportsGenerated'];
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

// ── Credit / entitlement functions (P1) ─────────────────────────────────

// Coarse view of what a rider is entitled to. Paid unlimited plans bypass the
// credit counter; everyone else is gated by reportCredits.
const UNLIMITED_PLANS = ['season', 'pro'];

export function getEntitlement(riderId) {
  const r = getRiderById(riderId);
  if (!r) return null;
  const unlimited = UNLIMITED_PLANS.includes(r.plan);
  const credits = Number(r.reportCredits ?? 0);
  return {
    riderId: r.id,
    plan: r.plan || 'free',
    unlimited,
    reportCredits: credits,
    reportsGenerated: Number(r.reportsGenerated ?? 0),
    canGenerate: unlimited || credits > 0
  };
}

// Atomically consume one report credit. Returns the post-consume entitlement,
// or null if the rider cannot generate (0 credits and no unlimited plan).
// Unlimited-plan riders don't decrement; their reportsGenerated still increments.
export function consumeReportCredit(riderId) {
  const r = getRiderById(riderId);
  if (!r) return null;
  const unlimited = UNLIMITED_PLANS.includes(r.plan);
  const credits = Number(r.reportCredits ?? 0);
  if (!unlimited && credits <= 0) return null;
  const now = new Date().toISOString();
  if (unlimited) {
    run(`UPDATE riders SET reportsGenerated = reportsGenerated + 1, updatedAt = ? WHERE id = ?`, [now, riderId]);
  } else {
    run(`UPDATE riders SET reportCredits = reportCredits - 1, reportsGenerated = reportsGenerated + 1, updatedAt = ? WHERE id = ?`, [now, riderId]);
  }
  return getEntitlement(riderId);
}

// Add credits to a rider (promo redemption, admin grant, later: paid purchase).
export function addReportCredits(riderId, amount) {
  const n = Math.max(0, parseInt(amount, 10) || 0);
  if (n === 0) return getEntitlement(riderId);
  const now = new Date().toISOString();
  run(`UPDATE riders SET reportCredits = COALESCE(reportCredits, 0) + ?, updatedAt = ? WHERE id = ?`, [n, now, riderId]);
  return getEntitlement(riderId);
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

export function getDeviceSessions({ date } = {}) {
  let sql = 'SELECT * FROM sessions WHERE riderId IS NULL ORDER BY createdAt DESC';
  const params = [];
  if (date) {
    sql = 'SELECT * FROM sessions WHERE riderId IS NULL AND date(createdAt) = ? ORDER BY createdAt DESC';
    params.push(date);
  }
  const rows = queryAll(sql, params);
  return rows.map(row => {
    if (row.analysisData) row.analysisData = JSON.parse(row.analysisData);
    return row;
  });
}

export function getAllSessions({ date } = {}) {
  let sql = 'SELECT id, riderId, deviceName, riderName, slotId, name, track, bike, date, analysisData, createdAt FROM sessions ORDER BY createdAt DESC';
  const params = [];
  if (date) {
    sql = 'SELECT id, riderId, deviceName, riderName, slotId, name, track, bike, date, analysisData, createdAt FROM sessions WHERE date(createdAt) = ? ORDER BY createdAt DESC';
    params.push(date);
  }
  const rows = queryAll(sql, params);
  return rows.map(row => {
    if (row.analysisData) row.analysisData = JSON.parse(row.analysisData);
    return row;
  });
}

export function getSessionById(id) {
  return getSessionByToken(id);
}

// ── Beta signup functions ────────────────────────────────────────────────────

export function createBetaSignup({ id, firstName, lastName, email, bike, track, experience, source, consent, confirmToken, confirmTokenExpiry, submittedAt, ip }) {
  const now = new Date().toISOString();
  run(`
    INSERT OR IGNORE INTO beta_signups (id, firstName, lastName, email, bike, track, experience, source, consent, confirmed, confirmToken, confirmTokenExpiry, submittedAt, ip, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `, [id, firstName, lastName, email, bike || null, track || null, experience || null, source || null, consent ? 1 : 0, confirmToken || null, confirmTokenExpiry || null, submittedAt || null, ip || null, now]);
  return queryOne('SELECT * FROM beta_signups WHERE email = ?', [email]);
}

export function getBetaSignupByEmail(email) {
  return queryOne('SELECT * FROM beta_signups WHERE email = ?', [email]);
}

export function getBetaSignupByConfirmToken(token) {
  return queryOne('SELECT * FROM beta_signups WHERE confirmToken = ?', [token]);
}

// Re-issue a fresh confirm token (+ expiry) for an existing (unconfirmed) signup.
export function setBetaConfirmToken(email, confirmToken, confirmTokenExpiry = null) {
  run('UPDATE beta_signups SET confirmToken = ?, confirmTokenExpiry = ? WHERE email = ?', [confirmToken, confirmTokenExpiry, email]);
  return queryOne('SELECT * FROM beta_signups WHERE email = ?', [email]);
}

export function confirmBetaSignup(id) {
  run('UPDATE beta_signups SET confirmed = 1, confirmedAt = ?, confirmToken = NULL WHERE id = ?', [new Date().toISOString(), id]);
  return queryOne('SELECT * FROM beta_signups WHERE id = ?', [id]);
}

export function getBetaSignups() {
  return queryAll('SELECT * FROM beta_signups ORDER BY createdAt DESC');
}

export function getBetaSignupStats() {
  const db = getDb();
  const total = queryOne('SELECT COUNT(*) as count FROM beta_signups')?.count || 0;
  const confirmed = queryOne('SELECT COUNT(*) as count FROM beta_signups WHERE confirmed = 1')?.count || 0;
  const byExperience = queryAll('SELECT experience, COUNT(*) as count FROM beta_signups WHERE experience IS NOT NULL GROUP BY experience');
  const byTrack = queryAll('SELECT track, COUNT(*) as count FROM beta_signups WHERE track IS NOT NULL GROUP BY track');
  return { total, confirmed, byExperience, byTrack };
}

export function deleteBetaSignup(email) {
  run('DELETE FROM beta_signups WHERE email = ?', [email]);
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
          submittedAt: signup.submittedAt || signup.created_at || null,
          ip: signup.ip || null
        });
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
  return queryAll('SELECT id, firstName, lastName, email, verified, plan, reportCredits, reportsGenerated, consentAt, ontarioAttestedAt, createdAt FROM riders ORDER BY createdAt DESC');
}

export function deleteRider(id) {
  run('DELETE FROM sessions WHERE riderId = ?', [id]);
  run('DELETE FROM riders WHERE id = ?', [id]);
}
