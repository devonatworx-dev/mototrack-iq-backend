'use strict';

// ── LemonSqueezy integration (SaaS revenue only) ────────────────────────────
// Handles checkout-URL creation and webhook signature verification + event
// mapping. The $59.99 in-person transponder-rental bundle is INTENTIONALLY not
// represented here — LemonSqueezy approval forbids rental units, so it stays
// off-platform (display card only on the site).
//
// All configuration comes from env vars so this module is inert until wired:
//   LEMONSQUEEZY_API_KEY   — API key (JWT) for the Checkouts API
//   LS_WEBHOOK_SECRET      — webhook signing secret (HMAC-SHA256)
//   LS_STORE_ID            — numeric store id (e.g. 457168)
//   LS_VARIANT_SINGLE      — variant id for Single Report ($5.99)
//   LS_VARIANT_EVENT       — variant id for Event Pass  ($19.99)
//   LS_VARIANT_SEASON      — variant id for Season Pass ($89.99)

import crypto from 'crypto';

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

// Map a product key -> what the backend grants on successful order.
// Event Pass = 6 credits (per Everett: "up to 6 sessions/day"; kept simple as
// flat credits for the first-20 intro, can be day-scoped post-beta).
export const PRODUCT_GRANTS = {
  single: { type: 'credits', amount: 1, label: 'Single Report' },
  event: { type: 'credits', amount: 6, label: 'Event Pass' },
  season: { type: 'plan', plan: 'season', label: 'Season Pass' },
};

// Resolve a variant id back to a product key (single|event|season) or null.
export function variantKey(variantId) {
  const { variants } = lsConfig();
  const id = String(variantId);
  if (id === String(variants.single)) return 'single';
  if (id === String(variants.event)) return 'event';
  if (id === String(variants.season)) return 'season';
  return null;
}

export function isConfigured() {
  const c = lsConfig();
  return Boolean(c.apiKey && c.storeId && c.variants.single && c.variants.event && c.variants.season);
}

// ── Checkout creation ───────────────────────────────────────────────────────
// Creates a hosted checkout for a given product key. We attach the rider id +
// email as custom data / prefill so the webhook can match the payment back to
// the rider. `quantity` is honored for the single-report add-to-cart case.
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
  const orderId = body?.data?.id || attrs?.identifier || null;

  // First-order items carry the variant id + quantity.
  const firstItem = attrs?.first_order_item || {};
  const variantId = firstItem?.variant_id != null ? String(firstItem.variant_id) : null;
  const quantity = Math.max(1, parseInt(firstItem?.quantity, 10) || 1);

  // Prefer explicit product_key from custom data, fall back to variant lookup.
  let productKey = custom?.product_key || null;
  if (!productKey && variantId) productKey = variantKey(variantId);
  if (!productKey) return null;

  const grant = PRODUCT_GRANTS[productKey];
  if (!grant) return null;

  return {
    riderId: custom?.rider_id ? String(custom.rider_id) : null,
    email: attrs?.user_email || null,
    productKey,
    quantity,
    orderId,
    grant,
  };
}
