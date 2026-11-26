import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';

const dbFile = path.join(os.tmpdir(), `mtiq-pricing-migrate-${process.pid}.db`);
process.env.DB_PATH = dbFile;
process.env.JWT_SECRET = ['test-jwt-secret', 'not-for-production', '0123456789'].join('-');

// Live file shape before this change: credits and plan exist, passes and the
// paid-session flag do not. Migration must not rewrite balances or updatedAt.
const rider = {
  id: 'rider-existing',
  email: 'pat.password@example.test',
  passwordHash: 'kept-password-hash',
  reportCredits: 4,
  reportsGenerated: 2,
  plan: 'season',
  updatedAt: '2026-06-02T00:00:00.000Z',
};

test('pass tables and the paid-session flag are additive and grandfather season stays unlimited', async () => {
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
      reportCredits INTEGER DEFAULT 1,
      reportsGenerated INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  seed.run(
    `INSERT INTO riders (id, firstName, lastName, email, passwordHash, verified, plan, reportCredits, reportsGenerated, createdAt, updatedAt)
     VALUES (?, 'Pat', 'Password', ?, ?, 1, ?, ?, ?, '2026-06-01T00:00:00.000Z', ?)`,
    [rider.id, rider.email, rider.passwordHash, rider.plan, rider.reportCredits, rider.reportsGenerated, rider.updatedAt],
  );
  seed.run(`
    CREATE TABLE sessions (
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
      createdAt TEXT NOT NULL
    )
  `);
  seed.run(
    `INSERT INTO sessions (id, riderId, name, date, createdAt) VALUES ('old-session', ?, 'Old', '2026-06-01', '2026-06-01T00:00:00.000Z')`,
    [rider.id],
  );
  fs.writeFileSync(dbFile, Buffer.from(seed.export()));
  seed.close();

  const db = await import('../lib/db.js');
  await db.initDb();

  const kept = db.getRiderById(rider.id);
  assert.equal(kept.reportCredits, 4);
  assert.equal(kept.reportsGenerated, 2);
  assert.equal(kept.plan, 'season');
  assert.equal(kept.passwordHash, rider.passwordHash);
  assert.equal(kept.updatedAt, rider.updatedAt);
  assert.equal(Number(kept.signupCreditGranted), 1);

  const oldSession = db.getSessionById('old-session');
  assert.equal(Number(oldSession.creditConsumed), 1);

  const ent = db.getEntitlement(rider.id);
  assert.equal(ent.unlimited, true);
  assert.equal(ent.grandfatheredUnlimited, true);
  assert.equal(ent.canGenerate, true);
  assert.equal(ent.dayReport.anyDate, true);
  assert.equal(ent.passes.season.length, 0);
  assert.equal(ent.reportCredits, 4);

  db.createSession({ id: 'new-session', riderId: rider.id, name: 'New', date: '2026-07-01' });
  assert.equal(Number(db.getSessionById('new-session').creditConsumed), 0);

  await db.initDb();
  assert.equal(db.getRiderById(rider.id).reportCredits, 4);
  assert.equal(db.getRiderById(rider.id).updatedAt, rider.updatedAt);
  assert.equal(Number(db.getSessionById('old-session').creditConsumed), 1);
  assert.equal(Number(db.getSessionById('new-session').creditConsumed), 0);

  db.updateRider(rider.id, { reportCredits: 0 });
  const broke = db.getEntitlement(rider.id);
  assert.equal(broke.reportCredits, 0);
  assert.equal(broke.unlimited, true);
  assert.equal(broke.canGenerate, true);
  const charge = db.consumeSessionCredit(rider.id, { sessionDate: '2026-08-01', sessionId: 'new-session' });
  assert.equal(charge.ok, true);
  assert.equal(charge.source, 'unlimited');
  assert.equal(db.getRiderById(rider.id).reportCredits, 0);

  fs.rmSync(dbFile, { force: true });
});
