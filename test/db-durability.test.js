import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mtiq-durable-'));
const dbFile = path.join(work, 'mototrackiq.db');
const backupDir = path.join(work, 'backups');
const adminKey = 'durability-admin-key';

process.env.JWT_SECRET = ['test-jwt-secret', 'not-for-production', '0123456789'].join('-');
process.env.DB_PATH = dbFile;
process.env.BACKUP_DIR = backupDir;
process.env.ADMIN_KEY = adminKey;
delete process.env.BACKUP_RETENTION;

const { initDb, createRider } = await import('../lib/db.js');
const { atomicWriteFile, createSerializer } = await import('../lib/atomic-file.js');
const {
  createBackup,
  listBackups,
  backupRetention,
  resolveBackupDir,
  verifySqliteFile,
  writeVerifiedSqliteFile,
  startDailyBackups,
  stopDailyBackups,
  DAILY_BACKUP_INTERVAL_MS,
} = await import('../lib/backup.js');
const { default: adminRoutes } = await import('../routes/admin.js');

import express from 'express';

const BACKUP_NAME = /^mototrackiq-\d{8}T\d{9}Z(?:-\d+)?\.db$/;
let server;
let base;

function fsIo(overrides = {}) {
  return {
    mkdirSync: (...args) => fs.mkdirSync(...args),
    openSync: (...args) => fs.openSync(...args),
    writeSync: (...args) => fs.writeSync(...args),
    fsyncSync: (...args) => fs.fsyncSync(...args),
    closeSync: (...args) => fs.closeSync(...args),
    renameSync: (...args) => fs.renameSync(...args),
    unlinkSync: (...args) => fs.unlinkSync(...args),
    ...overrides,
  };
}

function tmpNames(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.includes('.tmp'));
}

before(async () => {
  await initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  stopDailyBackups();
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(work, { recursive: true, force: true });
});

test('serializer runs a nested save only after the current one finishes', () => {
  const run = createSerializer();
  let active = 0;
  let max = 0;
  let passes = 0;
  run(() => {
    active += 1;
    max = Math.max(max, active);
    passes += 1;
    if (passes === 1) {
      run(() => {
        throw new Error('nested body must not start until the outer pass returns');
      });
    }
    active -= 1;
  });
  assert.equal(max, 1);
  assert.equal(passes, 2);
  assert.equal(active, 0);
});

test('atomic write fsyncs a temp file in the same directory, then renames over the destination', () => {
  const dir = fs.mkdtempSync(path.join(work, 'atomic-'));
  const dest = path.join(dir, 'mototrackiq.db');
  fs.writeFileSync(dest, 'OLD');
  const before = fs.statSync(dest);
  const events = [];
  const io = fsIo({
    openSync(file, flag, ...rest) {
      events.push(['open', file, flag]);
      return fs.openSync(file, flag, ...rest);
    },
    fsyncSync(fd) {
      events.push('fsync');
      return fs.fsyncSync(fd);
    },
    renameSync(from, to) {
      events.push(['rename', from, to]);
      assert.equal(path.dirname(from), dir);
      assert.equal(to, dest);
      assert.notEqual(from, dest);
      assert.equal(fs.readFileSync(from, 'utf8'), 'NEW');
      assert.equal(fs.readFileSync(dest, 'utf8'), 'OLD');
      return fs.renameSync(from, to);
    },
  });

  atomicWriteFile(dest, Buffer.from('NEW'), io);

  const after = fs.statSync(dest);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'NEW');
  assert.notEqual(after.ino, before.ino);
  assert.deepEqual(tmpNames(dir), []);

  const openedDest = events.filter((event) => Array.isArray(event) && event[0] === 'open' && event[1] === dest);
  assert.deepEqual(openedDest, []);
  const tempOpen = events.find((event) => Array.isArray(event) && event[0] === 'open' && event[2] === 'wx');
  assert.equal(path.dirname(tempOpen[1]), dir);
  const renameAt = events.findIndex((event) => Array.isArray(event) && event[0] === 'rename');
  const firstFsync = events.indexOf('fsync');
  assert.ok(firstFsync !== -1 && firstFsync < renameAt);
  assert.ok(events.indexOf('fsync', renameAt) > renameAt);
});

test('a failed fsync leaves the existing file and removes the temp file', () => {
  const dir = fs.mkdtempSync(path.join(work, 'atomic-fail-'));
  const dest = path.join(dir, 'mototrackiq.db');
  fs.writeFileSync(dest, 'ORIGINAL');
  const before = fs.statSync(dest);
  const io = fsIo({
    fsyncSync() {
      throw new Error('fsync failed');
    },
  });

  assert.throws(() => atomicWriteFile(dest, Buffer.from('NEW'), io), /fsync failed/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'ORIGINAL');
  assert.equal(fs.statSync(dest).ino, before.ino);
  assert.deepEqual(tmpNames(dir), []);
});

test('directory fsync failure after rename keeps the new file', () => {
  const dir = fs.mkdtempSync(path.join(work, 'atomic-dirfsync-'));
  const dest = path.join(dir, 'mototrackiq.db');
  fs.writeFileSync(dest, 'OLD');
  let fsyncs = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  const io = fsIo({
    fsyncSync(fd) {
      fsyncs += 1;
      if (fsyncs === 2) throw new Error('directory fsync failed');
      return fs.fsyncSync(fd);
    },
  });
  try {
    atomicWriteFile(dest, Buffer.from('NEW'), io);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(fs.readFileSync(dest, 'utf8'), 'NEW');
  assert.equal(fsyncs, 2);
  assert.ok(warnings.some((line) => line.includes('directory fsync failed')));
  assert.deepEqual(tmpNames(dir), []);
});

test('rider saves replace the database file and reopen with sql.js', async () => {
  createRider({ id: 'rider-1', firstName: 'Ada', lastName: 'One', email: 'ada.durable@example.com' });
  const first = fs.statSync(dbFile);
  createRider({ id: 'rider-2', firstName: 'Bea', lastName: 'Two', email: 'bea.durable@example.com' });
  const second = fs.statSync(dbFile);
  assert.notEqual(second.ino, first.ino);
  assert.deepEqual(tmpNames(path.dirname(dbFile)), []);

  const SQL = await initSqlJs();
  const opened = new SQL.Database(fs.readFileSync(dbFile));
  try {
    const rows = opened.exec('SELECT email FROM riders ORDER BY email');
    const emails = rows[0].values.map((row) => row[0]);
    assert.deepEqual(emails, ['ada.durable@example.com', 'bea.durable@example.com']);
  } finally {
    opened.close();
  }
});

test('backup retention defaults to 14 and the default directory is /data/backups', () => {
  const previousDir = process.env.BACKUP_DIR;
  const previousRetention = process.env.BACKUP_RETENTION;
  delete process.env.BACKUP_DIR;
  delete process.env.BACKUP_RETENTION;
  try {
    assert.equal(resolveBackupDir(), '/data/backups');
    assert.equal(backupRetention(), 14);
    process.env.BACKUP_RETENTION = '0';
    assert.equal(backupRetention(), 14);
    process.env.BACKUP_RETENTION = 'nope';
    assert.equal(backupRetention(), 14);
    process.env.BACKUP_RETENTION = '2.5';
    assert.equal(backupRetention(), 14);
    process.env.BACKUP_RETENTION = ' 4 ';
    assert.equal(backupRetention(), 4);
    assert.equal(DAILY_BACKUP_INTERVAL_MS, 24 * 60 * 60 * 1000);
  } finally {
    process.env.BACKUP_DIR = previousDir;
    if (previousRetention == null) delete process.env.BACKUP_RETENTION;
    else process.env.BACKUP_RETENTION = previousRetention;
  }
});

test('a backup that fails verification is removed and does not replace a good file', async () => {
  const dest = path.join(work, 'bad-backup.db');
  const keep = path.join(work, 'already-good.db');
  fs.writeFileSync(keep, fs.readFileSync(dbFile));
  await assert.rejects(writeVerifiedSqliteFile(dest, Buffer.from('this is not sqlite')));
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(keep), true);
  await verifySqliteFile(keep);
});

test('backups rotate to the retention count, verify, and ignore other files', async () => {
  process.env.BACKUP_RETENTION = '3';
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'keep me');
  fs.writeFileSync(path.join(backupDir, 'mototrackiq.db'), 'not a timestamped backup');

  const created = [];
  const first = createBackup();
  const overlapped = createBackup();
  const a = await first;
  const b = await overlapped;
  assert.equal(a.name, b.name);
  assert.match(a.name, BACKUP_NAME);
  created.push(a.name);

  for (let i = 0; i < 4; i += 1) {
    const backup = await createBackup();
    assert.match(backup.name, BACKUP_NAME);
    created.push(backup.name);
  }
  assert.equal(new Set(created).size, 5);

  const names = fs.readdirSync(backupDir).filter((name) => BACKUP_NAME.test(name)).sort();
  const kept = created.slice(-3).sort();
  assert.deepEqual(names, kept);
  assert.equal(fs.readFileSync(path.join(backupDir, 'notes.txt'), 'utf8'), 'keep me');
  assert.equal(fs.readFileSync(path.join(backupDir, 'mototrackiq.db'), 'utf8'), 'not a timestamped backup');

  const listed = listBackups();
  assert.deepEqual(listed.map((row) => row.name), [...created.slice(-3)].reverse());
  for (const row of listed) {
    assert.deepEqual(Object.keys(row).sort(), ['modifiedAt', 'name', 'size']);
    assert.equal(typeof row.size, 'number');
    assert.ok(row.size > 0);
    assert.equal(Number.isNaN(Date.parse(row.modifiedAt)), false);
    await verifySqliteFile(path.join(backupDir, row.name));
    const SQL = await initSqlJs();
    const opened = new SQL.Database(fs.readFileSync(path.join(backupDir, row.name)));
    try {
      const rows = opened.exec("SELECT email FROM riders WHERE email = 'ada.durable@example.com'");
      assert.equal(rows[0].values.length, 1);
    } finally {
      opened.close();
    }
  }

  const badPath = path.join(work, 'not-a-directory');
  fs.writeFileSync(badPath, 'x');
  const previousDir = process.env.BACKUP_DIR;
  process.env.BACKUP_DIR = badPath;
  await assert.rejects(createBackup());
  process.env.BACKUP_DIR = previousDir;
  const afterFailure = fs.readdirSync(backupDir).filter((name) => BACKUP_NAME.test(name)).sort();
  assert.deepEqual(afterFailure, kept);
});

test('admin backup routes require the admin key and do not return database bytes', async () => {
  const savedKey = process.env.ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  try {
    const unconfigured = await fetch(base + '/api/admin/backups');
    assert.equal(unconfigured.status, 503);
  } finally {
    process.env.ADMIN_KEY = savedKey;
  }

  const missing = await fetch(base + '/api/admin/backups');
  assert.equal(missing.status, 401);
  const wrong = await fetch(base + '/api/admin/backups', { headers: { 'x-admin-key': 'nope' } });
  assert.equal(wrong.status, 401);

  const createdRes = await fetch(base + '/api/admin/backups', {
    method: 'POST',
    headers: { 'x-admin-key': adminKey },
  });
  const createdBody = await createdRes.json();
  assert.equal(createdRes.status, 201);
  assert.equal(createdBody.success, true);
  assert.deepEqual(Object.keys(createdBody.backup).sort(), ['modifiedAt', 'name', 'size']);
  assert.match(createdBody.backup.name, BACKUP_NAME);
  assert.equal(JSON.stringify(createdBody).includes('ada.durable@example.com'), false);

  const listRes = await fetch(base + '/api/admin/backups', {
    headers: { 'x-admin-key': adminKey },
  });
  const listBody = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.equal(JSON.stringify(listBody).includes('ada.durable@example.com'), false);
  assert.equal(JSON.stringify(listBody).includes('SQLite format'), false);
  assert.ok(listBody.backups.some((row) => row.name === createdBody.backup.name));
  for (const row of listBody.backups) {
    assert.deepEqual(Object.keys(row).sort(), ['modifiedAt', 'name', 'size']);
  }

  const download = await fetch(base + '/api/admin/backups/' + createdBody.backup.name, {
    headers: { 'x-admin-key': adminKey },
  });
  const downloadText = await download.text();
  assert.equal(download.status, 404);
  assert.equal(downloadText.includes('SQLite format 3'), false);
  assert.equal(downloadText.includes('ada.durable@example.com'), false);
});

test('startup wires a backup and a daily schedule and does not restore', () => {
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const dbSrc = fs.readFileSync(path.join(root, 'lib/db.js'), 'utf8');
  const backupSrc = fs.readFileSync(path.join(root, 'lib/backup.js'), 'utf8');
  assert.match(serverSrc, /createBackup\(\)/);
  assert.match(serverSrc, /startDailyBackups\(\)/);
  assert.equal(/function\s+restore/i.test(serverSrc), false);
  assert.equal(/function\s+restore/i.test(dbSrc), false);
  assert.equal(/function\s+restore/i.test(backupSrc), false);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /Restore a backup by hand/);
  startDailyBackups();
  startDailyBackups();
  stopDailyBackups();
});
