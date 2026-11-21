import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(os.tmpdir(), `mtiq-profile-${process.pid}.db`);

process.env.JWT_SECRET = ['test-jwt-secret', 'not-for-production', '0123456789'].join('-');
process.env.DB_PATH = dbFile;

const require = createRequire(path.join(root, 'package.json'));
const express = require('express');
const jwt = require('jsonwebtoken');

const { initDb, createRider, getRiderById } = await import('../lib/db.js');
const { default: authRoutes, pickProfileUpdates } = await import('../routes/auth.js');

let server;
let base;

before(async () => {
  fs.rmSync(dbFile, { force: true });
  await initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dbFile, { force: true });
});

function seedRider(id, email) {
  createRider({
    id, firstName: 'probe', lastName: 'Old', email,
    phone: '555-0100', experience: 'Advanced', riderType: 'Track Only',
    bikes: 'R6', primaryTrack: 'Calabogie', lapTimer: 'AiM', notes: 'keep me',
    passwordHash: 'x',
  });
  return jwt.sign({ riderId: id }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function put(token, body) {
  const res = await fetch(`${base}/api/auth/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('a name-only update leaves every other profile field alone', async () => {
  const token = seedRider('r-name', 'name@example.com');
  const res = await put(token, { firstName: '  Devon ', lastName: 'Rider' });
  assert.equal(res.status, 200);
  assert.equal(res.body.rider.firstName, 'Devon');
  assert.equal(res.body.rider.lastName, 'Rider');
  const r = getRiderById('r-name');
  assert.equal(r.firstName, 'Devon');
  assert.equal(r.lastName, 'Rider');
  assert.equal(r.phone, '555-0100');
  assert.equal(r.experience, 'Advanced');
  assert.equal(r.riderType, 'Track Only');
  assert.equal(r.bikes, 'R6');
  assert.equal(r.primaryTrack, 'Calabogie');
  assert.equal(r.lapTimer, 'AiM');
  assert.equal(r.notes, 'keep me');
  assert.equal(r.passwordHash, 'x');
  assert.equal(res.body.rider.passwordHash, undefined);
});

test('updating one other field does not touch the name', async () => {
  const token = seedRider('r-bike', 'bike@example.com');
  const res = await put(token, { bikes: 'ZX-6R' });
  assert.equal(res.status, 200);
  const r = getRiderById('r-bike');
  assert.equal(r.bikes, 'ZX-6R');
  assert.equal(r.firstName, 'probe');
  assert.equal(r.phone, '555-0100');
});

test('blank first name, null name, wrong types and empty bodies are rejected without writing', async () => {
  const token = seedRider('r-bad', 'bad@example.com');
  for (const body of [{ firstName: '   ' }, { firstName: null }, { lastName: null }, { firstName: { x: 1 } }, { firstName: 'a'.repeat(61) }, {}, { passwordHash: 'hijack', plan: 'pro' }]) {
    const res = await put(token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const r = getRiderById('r-bad');
  assert.equal(r.firstName, 'probe');
  assert.equal(r.passwordHash, 'x');
});

test('non-profile keys such as plan or passwordHash are ignored', async () => {
  const token = seedRider('r-extra', 'extra@example.com');
  const before = getRiderById('r-extra');
  const res = await put(token, { lastName: '', plan: 'season', passwordHash: 'hijack', reportCredits: 99 });
  assert.equal(res.status, 200);
  const r = getRiderById('r-extra');
  assert.equal(r.lastName, '');
  assert.equal(r.passwordHash, 'x');
  assert.equal(r.plan, before.plan);
  assert.equal(r.reportCredits, before.reportCredits);
});

test('the profile route needs a valid token', async () => {
  const res = await fetch(`${base}/api/auth/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"firstName":"X"}' });
  assert.equal(res.status, 401);
});

test('pickProfileUpdates only returns keys that were sent', () => {
  assert.deepEqual(pickProfileUpdates({ firstName: 'A' }).updates, { firstName: 'A' });
  assert.deepEqual(pickProfileUpdates({ phone: '' }).updates, { phone: null });
  assert.deepEqual(pickProfileUpdates({ firstName: undefined, lastName: 'B' }).updates, { lastName: 'B' });
});

async function selectPlan(token, plan) {
  const res = await fetch(`${base}/api/auth/select-plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ plan }),
  });
  return { status: res.status, body: await res.json() };
}

test('select-plan cannot grant a paid (unlimited) plan', async () => {
  const token = seedRider('r-plan', 'plan@example.com');
  for (const plan of ['season', 'pro']) {
    const res = await selectPlan(token, plan);
    assert.equal(res.status, 402, plan);
    assert.equal(res.body.code, 'checkout_required');
  }
  const r = getRiderById('r-plan');
  assert.ok(!['season', 'pro'].includes(r.plan));
  const free = await selectPlan(token, 'free');
  assert.equal(free.status, 200);
  assert.equal(getRiderById('r-plan').plan, 'free');
});

test('select-plan never downgrades a rider who already paid for Season', async () => {
  const token = seedRider('r-paid', 'paid@example.com');
  const { updateRider } = await import('../lib/db.js');
  updateRider('r-paid', { plan: 'season' });
  const res = await selectPlan(token, 'free');
  assert.equal(res.status, 200);
  assert.equal(getRiderById('r-paid').plan, 'season');
});
