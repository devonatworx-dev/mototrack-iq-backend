'use strict';

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import { atomicWriteFile } from './atomic-file.js';
import { getDbFilePath, persistDb } from './db.js';

const DEFAULT_BACKUP_DIR = '/data/backups';
const DEFAULT_RETENTION = 14;
export const DAILY_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// mototrackiq-20261125T041030123Z.db or mototrackiq-20261125T041030123Z-2.db
const BACKUP_NAME = /^mototrackiq-(\d{8}T\d{9}Z)(?:-(\d+))?\.db$/;

let sqlPromise = null;
let retentionWarningShown = false;
let inflight = null;
let dailyTimer = null;

function loadSql() {
  if (!sqlPromise) sqlPromise = initSqlJs();
  return sqlPromise;
}

export function resolveBackupDir() {
  const configured = process.env.BACKUP_DIR;
  if (configured && configured.trim()) return configured.trim();
  return DEFAULT_BACKUP_DIR;
}

export function backupRetention() {
  const raw = process.env.BACKUP_RETENTION;
  if (raw == null || String(raw).trim() === '') return DEFAULT_RETENTION;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1) {
    if (!retentionWarningShown) {
      retentionWarningShown = true;
      console.warn(`[backup] BACKUP_RETENTION=${raw} is not a positive integer; using ${DEFAULT_RETENTION}`);
    }
    return DEFAULT_RETENTION;
  }
  return n;
}

function backupIdentity(name) {
  const match = BACKUP_NAME.exec(name);
  if (!match) return null;
  return { stamp: match[1], seq: match[2] ? Number(match[2]) : 1 };
}

function compareNewestFirst(a, b) {
  if (a.stamp !== b.stamp) return a.stamp < b.stamp ? 1 : -1;
  return b.seq - a.seq;
}

function readBackupEntries(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const identity = backupIdentity(name);
    if (!identity) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    entries.push({
      name,
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      stamp: identity.stamp,
      seq: identity.seq,
    });
  }
  entries.sort(compareNewestFirst);
  return entries;
}

export function listBackups() {
  return readBackupEntries(resolveBackupDir()).map(({ name, size, modifiedAt }) => ({
    name,
    size,
    modifiedAt,
  }));
}

function nextBackupName(dir, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');
  let seq = 1;
  let name = `mototrackiq-${stamp}.db`;
  while (fs.existsSync(path.join(dir, name))) {
    seq += 1;
    name = `mototrackiq-${stamp}-${seq}.db`;
  }
  return name;
}

/**
 * Open a file with sql.js and require a clean integrity check.
 * Throws if the file is missing, empty, or not a readable SQLite database.
 * Does not write the file.
 */
export async function verifySqliteFile(filePath) {
  const SQL = await loadSql();
  const bytes = fs.readFileSync(filePath);
  if (!bytes.length) throw new Error('database file is empty');
  let db;
  try {
    db = new SQL.Database(bytes);
    const result = db.exec('PRAGMA integrity_check');
    const value = result?.[0]?.values?.[0]?.[0];
    if (value !== 'ok') {
      throw new Error(`integrity check failed: ${value == null ? 'no result' : value}`);
    }
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

export async function writeVerifiedSqliteFile(dest, bytes) {
  atomicWriteFile(dest, bytes);
  try {
    await verifySqliteFile(dest);
  } catch (err) {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    throw err;
  }
}

function ensureBackupDir(dir) {
  const configured = process.env.BACKUP_DIR && process.env.BACKUP_DIR.trim();
  if (!configured) {
    // Production default is the Railway volume mount. Refuse to create /data
    // when the volume is not there; a local machine should set BACKUP_DIR.
    if (!fs.existsSync('/data') || !fs.statSync('/data').isDirectory()) {
      throw new Error('/data is not mounted; backups stay in /data/backups only when that volume is present (or set BACKUP_DIR)');
    }
  }
  fs.mkdirSync(dir, { recursive: true });
}

function rotateBackups(dir, retention) {
  const entries = readBackupEntries(dir);
  const drop = entries.slice(retention);
  for (const entry of drop) {
    fs.unlinkSync(path.join(dir, entry.name));
  }
  return Math.min(entries.length, retention);
}

async function runBackup() {
  persistDb();
  const livePath = getDbFilePath();
  const bytes = fs.readFileSync(livePath);
  const dir = resolveBackupDir();
  ensureBackupDir(dir);
  const name = nextBackupName(dir);
  const dest = path.join(dir, name);
  await writeVerifiedSqliteFile(dest, bytes);
  const retained = rotateBackups(dir, backupRetention());
  const st = fs.statSync(dest);
  return {
    name,
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
    retained,
  };
}

/**
 * Copy the live database into the backup directory, verify the copy by
 * opening it with sql.js, then keep only the newest BACKUP_RETENTION files.
 * Concurrent callers share one in-flight backup. Never reads backups back
 * onto the live database file.
 */
export function createBackup() {
  if (inflight) return inflight;
  inflight = runBackup()
    .then((backup) => {
      console.log(
        `[backup] wrote ${backup.name} (${backup.size} bytes, ${backup.modifiedAt}); verified with sql.js; keeping ${backup.retained}`,
      );
      return { name: backup.name, size: backup.size, modifiedAt: backup.modifiedAt };
    })
    .catch((err) => {
      console.error(`[backup] failed: ${err.message}`);
      throw err;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function startDailyBackups() {
  if (dailyTimer) return;
  dailyTimer = setInterval(() => {
    createBackup().catch(() => {
      // createBackup already logged the failure.
    });
  }, DAILY_BACKUP_INTERVAL_MS);
  if (typeof dailyTimer.unref === 'function') dailyTimer.unref();
}

export function stopDailyBackups() {
  if (!dailyTimer) return;
  clearInterval(dailyTimer);
  dailyTimer = null;
}
