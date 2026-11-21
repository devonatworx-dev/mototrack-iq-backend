import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';

const dbFile = path.join(os.tmpdir(), `mtiq-migrate-${process.pid}.db`);
process.env.DB_PATH = dbFile;

// Shape of the live riders table after the nullable-password migration:
// passwordHash is nullable, credits and Ontario columns already exist.
// initDb must add OAuth tables without rewriting this rider or the waitlist row.
const rider = {
  id: 'rider-existing',
  firstName: 'Pat',
  lastName: 'Password',
  email: 'pat.password@example.test',
  passwordHash: '$2a$10$existinghashvalueexistinghashvalueex',
  lapTimer: 'AiM Solo',
  notes: 'keep-me',
  verified: 1,
  reportCredits: 3,
  reportsGenerated: 2,
  ontarioAttestedAt: '2026-06-01T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
};

test('oauth tables are additive on an existing database and waitlist rows stay put', async () => {
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
    `INSERT INTO riders (id, firstName, lastName, email, passwordHash, lapTimer, notes, verified, reportCredits, reportsGenerated, ontarioAttestedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [rider.id, rider.firstName, rider.lastName, rider.email, rider.passwordHash, rider.lapTimer, rider.notes, rider.verified, rider.reportCredits, rider.reportsGenerated, rider.ontarioAttestedAt, rider.createdAt, rider.updatedAt],
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
      converted INTEGER DEFAULT 0,
      convertedAt TEXT,
      convertedRiderId TEXT,
      submittedAt TEXT,
      ip TEXT,
      createdAt TEXT NOT NULL
    )
  `);
  seed.run(
    `INSERT INTO beta_signups (id, firstName, lastName, email, consent, confirmed, createdAt)
     VALUES ('beta-1', 'Wait', 'List', 'wait.unconfirmed@example.test', 1, 0, '2026-05-01T00:00:00.000Z')`,
  );
  fs.writeFileSync(dbFile, Buffer.from(seed.export()));
  seed.close();

  const { initDb, getRiderByEmail, getBetaSignupByEmail, saveOAuthState, takeOAuthState } = await import('../lib/db.js');
  await initDb();

  const kept = getRiderByEmail(rider.email);
  assert.equal(kept.id, rider.id);
  assert.equal(kept.passwordHash, rider.passwordHash);
  assert.equal(kept.notes, rider.notes);
  assert.equal(kept.lapTimer, rider.lapTimer);
  assert.equal(kept.reportCredits, rider.reportCredits);
  assert.equal(kept.reportsGenerated, rider.reportsGenerated);
  assert.equal(kept.ontarioAttestedAt, rider.ontarioAttestedAt);
  assert.equal(kept.updatedAt, rider.updatedAt);

  const wait = getBetaSignupByEmail('wait.unconfirmed@example.test');
  assert.equal(wait.id, 'beta-1');
  assert.equal(Number(wait.confirmed), 0);
  assert.equal(Number(wait.converted || 0), 0);

  saveOAuthState({
    state: 'state-1',
    provider: 'google',
    verifier: 'verifier',
    consent: false,
    ontario: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const state = takeOAuthState('state-1');
  assert.equal(state.provider, 'google');

  const check = new SQL.Database(fs.readFileSync(dbFile));
  const tables = check.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'oauth_%' ORDER BY name")[0].values.map((row) => row[0]);
  assert.deepEqual(tables, ['oauth_codes', 'oauth_identities', 'oauth_states']);
  const still = check.exec('SELECT id, passwordHash, notes, reportCredits FROM riders')[0].values;
  assert.equal(still.length, 1);
  assert.deepEqual(still[0], [rider.id, rider.passwordHash, rider.notes, rider.reportCredits]);
  const stillWait = check.exec('SELECT email, confirmed FROM beta_signups')[0].values;
  assert.deepEqual(stillWait, [['wait.unconfirmed@example.test', 0]]);
  check.close();

  await initDb();
  const again = getRiderByEmail(rider.email);
  assert.equal(again.passwordHash, rider.passwordHash);
  assert.equal(again.notes, rider.notes);
  assert.equal(getBetaSignupByEmail('wait.unconfirmed@example.test').id, 'beta-1');

  fs.rmSync(dbFile, { force: true });
});
