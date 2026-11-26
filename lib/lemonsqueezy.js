'use strict';

// ── LemonSqueezy integration (SaaS revenue only) ────────────────────────────
// Handles checkout-URL creation and webhook signature verification + event
// mapping. The CA$59.99 Special Event Bundle (in-person transponder rental)
// is INTENTIONALLY not represented here — no variant env, no product key, and
// the webhook cannot grant it. Lemon Squeezy approval forbids rental units.
//
// All configuration comes from env vars so this module is inert until wired:
//   LEMONSQUEEZY_API_KEY   — API key (JWT) for the Checkouts API
//   LS_WEBHOOK_SECRET      — webhook signing secret (HMAC-SHA256)
//   LS_STORE_ID            — numeric store id (e.g. 457168)
//   LS_VARIANT_SINGLE      — variant id for Single Report ($5.99)
//   LS_VARIANT_EVENT       — variant id for Event Pass  ($19.99)
//   LS_VARIANT_SEASON      — variant id for Season Pass ($89.99)
//   LS_TEST_MODE           — 'true' only on a server wired to the TEST store;
//                            test-mode orders are ignored otherwise

import crypto from 'crypto';
import { CHECKOUT_PRODUCT_KEYS, PASS_SPECS, SINGLE_REPORT_CREDITS } from './pricing.js';

const LS_API = 'https://api.lemonsqueezy.com/v1';

export function lsConfig() {
  return {
    apiKey: process.env.LEMONSQUEEZY_API_KEY || '',
    webhookSecret: process.env.LS_WEBHOOK_SECRET || '',
    storeId: process.env.LS_STORE_ID || '',
    variants: {
      single: process.env.LS_VARIANT_SINGLE || '',
      event: process.env.LS_VARIANT_EVENT || '',
      season: process.env.LS_VARIANT_SEASON || '',
    },
  };
}

// What a paid variant grants. Season is a day-capped pass, not plan='season'.
// There is no Special Event Bundle entry.
export const PRODUCT_GRANTS = {
  single: { type: 'credits', amount: SINGLE_REPORT_CREDITS, label: 'Single Report' },
  event: { type: 'event_pass', amount: PASS_SPECS.event.credits, label: 'Event Pass' },
  season: { type: 'season_pass', amount: PASS_SPECS.season.credits, label: 'Season Pass' },
};

// Resolve a paid variant id to single|event|season. Empty config never matches.
export function variantKey(variantId) {
  if (variantId == null || String(variantId).trim() === '') return null;
  const { variants } = lsConfig();
  const id = String(variantId);
  for (const key of CHECKOUT_PRODUCT_KEYS) {
    const configured = variants[key];
    if (!configured) continue;
    if (id === String(configured)) return key;
  }
  return null;
}

export function isTestModeAllowed() {
  return /^(1|true|yes)$/i.test(String(process.env.LS_TEST_MODE || '').trim());
}

export function isConfigured() {
  const c = lsConfig();
  return Boolean(c.apiKey && c.storeId && c.variants.single && c.variants.event && c.variants.season);
}

// ── Checkout creation ───────────────────────────────────────────────────────
// Creates a hosted checkout for a given product key. We attach the rider id
// as custom data so the webhook can match the payment back to the rider.
// product_key is sent for mismatch logs only. The webhook grants from the
// paid variant id, never from this field. `quantity` is the single-report cart.
export async function createCheckout({ productKey, rider, quantity = 1 }) {
  const c = lsConfig();
  if (!c.apiKey || !c.storeId) throw new Error('LemonSqueezy not configured');
  const variantId = c.variants[productKey];
  if (!variantId) throw new Error(`Unknown product: ${productKey}`);

  const qty = Math.max(1, parseInt(quantity, 10) || 1);

  const payload = {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: {
          email: rider?.email || undefined,
          name: rider ? `${rider.firstName || ''} ${rider.lastName || ''}`.trim() || undefined : undefined,
          custom: {
            rider_id: String(rider?.id || ''),
            product_key: productKey,
          },
          // Single Report supports quantity selection (add-to-cart).
          ...(productKey === 'single' && qty > 1 ? { variant_quantities: [{ variant_id: Number(variantId), quantity: qty }] } : {}),
        },
        checkout_options: { embed: false, dark: true },
        product_options: {
          redirect_url: (process.env.FRONTEND_URL || 'https://mototrackiq.com') + '/?checkout=success',
          receipt_button_text: 'Return to MotoTrackIQ',
          receipt_thank_you_note: 'Thanks! Your report credits are now on your account.',
        },
      },
      relationships: {
        store: { data: { type: 'stores', id: String(c.storeId) } },
        variant: { data: { type: 'variants', id: String(variantId) } },
      },
    },
  };

  const resp = await fetch(`${LS_API}/checkouts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.apiKey}`,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`LemonSqueezy checkout failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Invalid LemonSqueezy response'); }
  const url = json?.data?.attributes?.url;
  if (!url) throw new Error('No checkout URL returned');
  return url;
}

// ── Webhook signature verification ──────────────────────────────────────────
// LemonSqueezy signs the raw request body with HMAC-SHA256 using the webhook
// signing secret, delivered in the `X-Signature` header (hex).
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const c = lsConfig();
  if (!c.webhookSecret) return false;
  if (!signatureHeader) return false;
  const hmac = crypto.createHmac('sha256', c.webhookSecret);
  const digest = hmac.update(rawBody).digest('hex');
  try {
    const a = Buffer.from(digest, 'hex');
    const b = Buffer.from(String(signatureHeader), 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Parse an order_created webhook body into a normalized grant instruction.
// Returns { riderId, productKey, quantity, orderId, grant } or null if we can't
// resolve it to one of our SaaS products.
export function parseOrderWebhook(body) {
  const event = body?.meta?.event_name;
  if (event !== 'order_created') return null;

  const custom = body?.meta?.custom_data || {};
  const attrs = body?.data?.attributes || {};

  // Lemon Squeezy marks test-mode orders. Only honour them when this server is
  // explicitly running against a test store (LS_TEST_MODE=true), so a test
  // purchase can never grant credits on a live account by accident.
  const isTestOrder = attrs?.test_mode === true || body?.meta?.test_mode === true;
  if (isTestOrder && !isTestModeAllowed()) return null;
  const orderId = body?.data?.id || attrs?.identifier || null;

  // The paid line item is the only product source. meta.custom_data.product_key
  // is caller-controlled (and echoed from checkout) and must not select a grant.
  const firstItem = attrs?.first_order_item || {};
  const variantId = firstItem?.variant_id != null && String(firstItem.variant_id).trim() !== ''
    ? String(firstItem.variant_id)
    : null;
  const quantity = Math.max(1, parseInt(firstItem?.quantity, 10) || 1);

  const productKey = variantId ? variantKey(variantId) : null;
  if (!productKey) return null;

  const grant = PRODUCT_GRANTS[productKey];
  if (!grant) return null;

  const claimedProductKey = custom?.product_key ? String(custom.product_key) : null;

  return {
    riderId: custom?.rider_id ? String(custom.rider_id) : null,
    email: attrs?.user_email || null,
    productKey,
    claimedProductKey,
    productKeyMismatch: Boolean(claimedProductKey && claimedProductKey !== productKey),
    variantId,
    quantity,
    orderId,
    grant,
  };
}
