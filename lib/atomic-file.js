'use strict';

import fs from 'fs';
import path from 'path';

/**
 * Run `fn` so a nested call does not overlap the one in progress.
 * A nested call sets a flag; when the current call finishes, `fn` runs once
 * more and sees whatever changed during the first pass. Synchronous callers
 * (the database save) therefore never have two writes in flight together.
 */
export function createSerializer() {
  let running = false;
  let again = false;
  return function run(fn) {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        fn();
      } while (again);
    } finally {
      running = false;
    }
  };
}

/**
 * Replace `destPath` by writing a temp file in the same directory, fsyncing
 * that file, then renaming it over the destination. The destination path is
 * never opened for write, so a crash mid-write leaves the previous file intact.
 * `io` defaults to node:fs. Tests pass a wrapper to observe or fail a step.
 */
export function atomicWriteFile(destPath, data, io = fs) {
  const dir = path.dirname(destPath);
  io.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(destPath)}.${process.pid}.${process.hrtime.bigint().toString(36)}.tmp`,
  );
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let fd;
  try {
    fd = io.openSync(tmp, 'wx');
    let offset = 0;
    while (offset < buf.length) {
      const wrote = io.writeSync(fd, buf, offset, buf.length - offset, offset);
      if (wrote <= 0) throw new Error(`atomic write made no progress for ${destPath}`);
      offset += wrote;
    }
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(tmp, destPath);
  } catch (err) {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch { /* ignore */ }
    }
    try { io.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  // Durability of the directory entry after rename. Failure here does not
  // roll back the rename; the new file is already in place.
  try {
    const dirFd = io.openSync(dir, 'r');
    try {
      io.fsyncSync(dirFd);
    } finally {
      io.closeSync(dirFd);
    }
  } catch (err) {
    console.warn(`[db] directory fsync failed for ${dir}: ${err.message}`);
  }
}
