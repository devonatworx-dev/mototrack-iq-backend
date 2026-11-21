import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(os.tmpdir(), `mtiq-checkout-${process.pid}.db`);

process.env.JWT_SECRET = ['test-jwt-secret', 'not-for-production', '0123456789'].join('-');
process.env.DB_PATH = dbFile;
process.env.FRONTEND_URL = 'http://127.0.0.1:43128';
const LS_KEYS = ['LEMONSQUEEZY_API_KEY', 'LS_STORE_ID', 'LS_VARIANT_SINGLE', 'LS_VARIANT_EVENT', 'LS_VARIANT_SEASON', 'LS_WEBHOOK_SECRET', 'LS_TEST_MODE'];
for (const k of LS_KEYS) delete process.env[k];

const require = createRequire(path.join(root, 'package.json'));
const express = require('express');
const jwt = require('jsonwebtoken');

const { initDb, createRider, getRiderById } = await import('../lib/db.js');
const { default: checkoutRoutes } = await import('../routes/checkout.js');

let server;
let base;
const realFetch = globalThis.fetch;

function configureTestStore() {
  Object.assign(process.env, {
    LEMONSQUEEZY_API_KEY: 'test-key-not-real',
    LS_STORE_ID: '1',
    LS_VARIANT_SINGLE: '101',
    LS_VARIANT_EVENT: '102',
    LS_VARIANT_SEASON: '103',
    LS_WEBHOOK_SECRET: 'whsec-test',
  });
}

before(async () => {
  fs.rmSync(dbFile, { force: true });
  await initDb();
  createRider({ id: 'buyer', firstName: 'Buyer', lastName: 'One', email: 'buyer@example.com', passwordHash: 'x' });
  const app = express();
  app.use('/api/webhooks/lemonsqueezy', express.raw({ type: '*/*' }), checkoutRoutes);
  app.use(express.json());
  app.use('/api', checkoutRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => { globalThis.fetch = realFetch; for (const k of LS_KEYS) delete process.env[k]; });
after(async () => { if (server) await new Promise((r) => server.close(r)); fs.rmSync(dbFile, { force: true }); });

const token = () => jwt.sign({ riderId: 'buyer' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const checkout = (product) => realFetch(`${base}/api/checkout/${product}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: '{}' });

test('checkout answers 503 until the store is configured, and 400 for an unknown product like pro', async () => {
  assert.equal((await checkout('season')).status, 503);
  assert.equal((await checkout('pro')).status, 400);
  const anon = await realFetch(`${base}/api/checkout/season`, { method: 'POST' });
  assert.equal(anon.status, 401);
});

test('checkout sends the right variant and rider id and returns the hosted URL', async () => {
  configureTestStore();
  let sent;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    sent = JSON.parse(opts.body);
    return { ok: true, status: 201, text: async () => JSON.stringify({ data: { attributes: { url: 'https://store.lemonsqueezy.com/checkout/test' } } }) };
  };
  for (const [product, variant] of [['single', '101'], ['event', '102'], ['season', '103']]) {
    const res = await checkout(product);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).url, 'https://store.lemonsqueezy.com/checkout/test');
    assert.equal(sent.data.relationships.variant.data.id, variant);
    assert.equal(sent.data.attributes.checkout_data.custom.rider_id, 'buyer');
    assert.equal(sent.data.attributes.checkout_data.custom.product_key, product);
  }
});

function signed(body) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', 'whsec-test').update(raw).digest('hex');
  return realFetch(`${base}/api/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sig }, body: raw });
}

const order = (id, testMode) => ({
  meta: { event_name: 'order_created', custom_data: { rider_id: 'buyer', product_key: 'event' } },
  data: { id, attributes: { test_mode: testMode, first_order_item: { variant_id: 102, quantity: 1 } } },
});

test('a test-mode order is ignored unless LS_TEST_MODE=true', async () => {
  configureTestStore();
  const before = getRiderById('buyer').reportCredits || 0;
  const ignored = await signed(order('o-test-1', true));
  assert.equal((await ignored.json()).ignored, true);
  assert.equal(getRiderById('buyer').reportCredits || 0, before);

  process.env.LS_TEST_MODE = 'true';
  const granted = await signed(order('o-test-2', true));
  assert.equal((await granted.json()).ok, true);
  assert.equal(getRiderById('buyer').reportCredits || 0, before + 6);

  const dup = await signed(order('o-test-2', true));
  assert.equal((await dup.json()).duplicate, true);
});

test('a live order grants once, and a bad signature is refused', async () => {
  configureTestStore();
  const before = getRiderById('buyer').reportCredits || 0;
  const res = await signed(order('o-live-1', false));
  assert.equal((await res.json()).ok, true);
  assert.equal(getRiderById('buyer').reportCredits || 0, before + 6);
  const bad = await realFetch(`${base}/api/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'X-Signature': 'deadbeef' }, body: JSON.stringify(order('o-live-2', false)) });
  assert.equal(bad.status, 401);
});
