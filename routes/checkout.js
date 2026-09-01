'use strict';

// ── Checkout + webhook routes (LemonSqueezy, SaaS revenue only) ──────────────
// POST /api/checkout/:product   (auth) -> returns a hosted LemonSqueezy checkout URL
// POST /api/webhooks/lemonsqueezy       -> verifies signature, grants credits/plan
//
// The webhook route MUST receive the RAW body for signature verification. That
// is wired in server.js by mounting express.raw() for this specific path BEFORE
// the global express.json() middleware.

import express from 'express';
import { requireAuth } from '../lib/middleware/auth.js';
import {
  getRiderById,
  addReportCredits,
  updateRider,
  getEntitlement,
  hasProcessedOrder,
  recordProcessedOrder,
} from '../lib/db.js';
import {
  createCheckout,
  isConfigured,
  verifyWebhookSignature,
  parseOrderWebhook,
} from '../lib/lemonsqueezy.js';

const router = express.Router();

const PRODUCT_KEYS = ['single', 'event', 'season'];

// ── Create checkout URL ─────────────────────────────────────────────────────
// POST /api/checkout/:product  { quantity? }
router.post('/checkout/:product', requireAuth, async (req, res) => {
  try {
    const productKey = String(req.params.product || '').toLowerCase();
    if (!PRODUCT_KEYS.includes(productKey)) {
      return res.status(400).json({ error: 'Invalid product' });
    }
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Payments are not configured yet. Check back soon.' });
    }
    const rider = getRiderById(req.riderId);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });

    const quantity = productKey === 'single' ? (req.body?.quantity || 1) : 1;
    const url = await createCheckout({ productKey, rider, quantity });
    res.json({ url });
  } catch (err) {
    console.error('[checkout]', err.message);
    res.status(502).json({ error: 'Could not create checkout. Please try again.' });
  }
});

// ── Webhook receiver ────────────────────────────────────────────────────────
// POST /api/webhooks/lemonsqueezy   (raw body, X-Signature header)
router.post('/webhooks/lemonsqueezy', (req, res) => {
  try {
    // req.body is a Buffer here (express.raw mounted for this path).
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const signature = req.headers['x-signature'];

    if (!verifyWebhookSignature(raw, signature)) {
      console.warn('[ls-webhook] signature verification FAILED');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let body;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch { return res.status(400).json({ error: 'Invalid JSON' }); }

    const parsed = parseOrderWebhook(body);
    if (!parsed) {
      // Not an order_created we care about — ack so LS doesn't retry.
      return res.status(200).json({ ignored: true });
    }

    // Idempotency: never grant twice for the same order.
    if (parsed.orderId && hasProcessedOrder(parsed.orderId)) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    // Resolve rider: prefer the rider_id passed through custom data.
    let riderId = parsed.riderId;
    if (!riderId) {
      console.warn('[ls-webhook] no rider_id in custom data; order', parsed.orderId, 'email', parsed.email);
      // Ack (200) so LS stops retrying, but record nothing — needs manual reconcile.
      if (parsed.orderId) recordProcessedOrder(parsed.orderId, null, parsed.productKey, 'unmatched');
      return res.status(200).json({ ok: true, unmatched: true });
    }

    const rider = getRiderById(riderId);
    if (!rider) {
      console.warn('[ls-webhook] rider not found:', riderId, 'order', parsed.orderId);
      if (parsed.orderId) recordProcessedOrder(parsed.orderId, riderId, parsed.productKey, 'rider_missing');
      return res.status(200).json({ ok: true, unmatched: true });
    }

    // Apply the grant.
    const grant = parsed.grant;
    if (grant.type === 'credits') {
      const total = grant.amount * (parsed.quantity || 1);
      addReportCredits(riderId, total);
      console.log(`[ls-webhook] +${total} credits to rider ${riderId} (${grant.label} x${parsed.quantity})`);
    } else if (grant.type === 'plan') {
      updateRider(riderId, { plan: grant.plan });
      console.log(`[ls-webhook] set plan=${grant.plan} for rider ${riderId} (${grant.label})`);
    }

    if (parsed.orderId) recordProcessedOrder(parsed.orderId, riderId, parsed.productKey, 'granted');

    return res.status(200).json({ ok: true, entitlement: getEntitlement(riderId) });
  } catch (err) {
    console.error('[ls-webhook] error:', err);
    // Return 200 to avoid infinite LS retries on our own bugs; we log for reconcile.
    return res.status(200).json({ ok: false });
  }
});

export default router;
