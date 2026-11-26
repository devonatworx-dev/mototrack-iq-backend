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

const { initDb, createRider, getRiderById, getEntitlement } = await import('../lib/db.js');
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

test('checkout answers 503 until the store is configured, and 400 for an unknown product like pro or the in-person bundle', async () => {
  assert.equal((await checkout('season')).status, 503);
  assert.equal((await checkout('pro')).status, 400);
  assert.equal((await checkout('bundle')).status, 400);
  assert.equal((await checkout('special-event-bundle')).status, 400);
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
  const passesBefore = getEntitlement('buyer').passes.event.length;
  const granted = await signed(order('o-test-2', true));
  assert.equal((await granted.json()).ok, true);
  const ent = getEntitlement('buyer');
  assert.equal(getRiderById('buyer').reportCredits || 0, before);
  assert.equal(ent.passes.event.length, passesBefore + 1);
  assert.equal(ent.passes.event.at(-1).creditsRemaining, 6);
  assert.equal(ent.passes.event.at(-1).boundDate, null);
  assert.equal(ent.unlimited, false);
  assert.equal(getRiderById('buyer').plan, null);

  const dup = await signed(order('o-test-2', true));
  assert.equal((await dup.json()).duplicate, true);
  assert.equal(getEntitlement('buyer').passes.event.length, passesBefore + 1);
});

test('a live order grants once, and a bad signature is refused', async () => {
  configureTestStore();
  const before = getRiderById('buyer').reportCredits || 0;
  const passesBefore = getEntitlement('buyer').passes.event.length;
  const res = await signed(order('o-live-1', false));
  assert.equal((await res.json()).ok, true);
  assert.equal(getRiderById('buyer').reportCredits || 0, before);
  assert.equal(getEntitlement('buyer').passes.event.length, passesBefore + 1);
  const bad = await realFetch(`${base}/api/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'X-Signature': 'deadbeef' }, body: JSON.stringify(order('o-live-2', false)) });
  assert.equal(bad.status, 401);
});

test('the product is taken from the paid variant, never from custom_data', async () => {
  configureTestStore();
  const { PRODUCT_GRANTS, lsConfig, parseOrderWebhook } = await import('../lib/lemonsqueezy.js');
  assert.deepEqual(Object.keys(lsConfig().variants).sort(), ['event', 'season', 'single']);
  assert.deepEqual(Object.keys(PRODUCT_GRANTS).sort(), ['event', 'season', 'single']);
  assert.equal(PRODUCT_GRANTS.season.type, 'season_pass');
  assert.equal(PRODUCT_GRANTS.season.plan, undefined);

  const flexBefore = getRiderById('buyer').reportCredits || 0;
  const seasonBefore = getEntitlement('buyer').passes.season.length;
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  try {
    const res = await signed({
      meta: { event_name: 'order_created', custom_data: { rider_id: 'buyer', product_key: 'season' } },
      data: { id: 'o-mismatch-single', attributes: { test_mode: false, first_order_item: { variant_id: 101, quantity: 3 } } },
    });
    assert.equal((await res.json()).ok, true);
  } finally {
    console.warn = orig;
  }
  assert.equal(getRiderById('buyer').reportCredits, flexBefore + 3);
  assert.equal(getEntitlement('buyer').passes.season.length, seasonBefore);
  assert.equal(getRiderById('buyer').plan, null);
  assert.equal(getEntitlement('buyer').unlimited, false);
  assert.ok(warnings.some((line) => line.includes('product_key=season') && line.includes('single')));

  const ignored = parseOrderWebhook({
    meta: { event_name: 'order_created', custom_data: { rider_id: 'buyer', product_key: 'season' } },
    data: { id: 'no-variant', attributes: { test_mode: false, first_order_item: { quantity: 1 } } },
  });
  assert.equal(ignored, null);

  const bundle = parseOrderWebhook({
    meta: { event_name: 'order_created', custom_data: { rider_id: 'buyer', product_key: 'special_event_bundle' } },
    data: { id: 'bundle', attributes: { test_mode: false, first_order_item: { variant_id: 5999, quantity: 1 } } },
  });
  assert.equal(bundle, null);

  const flexAfterBundleAttempt = getRiderById('buyer').reportCredits;
  const bundleHttp = await signed({
    meta: { event_name: 'order_created', custom_data: { rider_id: 'buyer', product_key: 'bundle' } },
    data: { id: 'o-bundle', attributes: { test_mode: false, first_order_item: { variant_id: 5999, quantity: 1 } } },
  });
  assert.equal((await bundleHttp.json()).ignored, true);
  assert.equal(getRiderById('buyer').reportCredits, flexAfterBundleAttempt);
  assert.equal(getEntitlement('buyer').passes.season.length, seasonBefore);
});

test('a season variant grants a day-capped pass and does not set plan=season', async () => {
  configureTestStore();
  const flexBefore = getRiderById('buyer').reportCredits || 0;
  const res = await signed({
    meta: { event_name: 'order_created', custom_data: { rider_id: 'buyer', product_key: 'single' } },
    data: { id: 'o-season', attributes: { test_mode: false, first_order_item: { variant_id: 103, quantity: 1 } } },
  });
  assert.equal((await res.json()).ok, true);
  const ent = getEntitlement('buyer');
  assert.equal(getRiderById('buyer').plan, null);
  assert.equal(ent.unlimited, false);
  assert.equal(ent.grandfatheredUnlimited, false);
  assert.equal(getRiderById('buyer').reportCredits, flexBefore);
  const pass = ent.passes.season.at(-1);
  assert.equal(pass.creditsTotal, 48);
  assert.equal(pass.creditsRemaining, 48);
  assert.equal(pass.dailyCap, 6);
  assert.equal(pass.maxDays, 8);
  assert.equal(pass.daysUsed, 0);
  assert.equal(ent.dayReport.season, true);
  assert.equal(ent.dayReport.anyDate, true);
});

test('event quantity grants separate day passes, not one larger wallet', async () => {
  configureTestStore();
  const before = getEntitlement('buyer').passes.event.length;
  const res = await signed({
    meta: { event_name: 'order_created', custom_data: { rider_id: 'buyer', product_key: 'event' } },
    data: { id: 'o-event-qty', attributes: { test_mode: false, first_order_item: { variant_id: 102, quantity: 2 } } },
  });
  assert.equal((await res.json()).ok, true);
  const event = getEntitlement('buyer').passes.event;
  assert.equal(event.length, before + 2);
  assert.equal(event.at(-1).creditsTotal, 6);
  assert.equal(event.at(-2).creditsTotal, 6);
});
