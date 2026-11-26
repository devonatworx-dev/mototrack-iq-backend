'use strict';

// Pricing the portal and Lemon Squeezy grants share.
//
// One credit pays for one saved session. The PDF for that session, including
// a later re-download, does not cost another credit. /api/analyze may refuse
// a rider who cannot pay, and it does not spend a credit.
//
// Flexible credits (riders.reportCredits): the one-time signup credit, each
// Single Report (CA$5.99, times quantity), promo codes, and admin grants.
// They can be used on any day, with no per-day cap.
//
// Event Pass (CA$19.99): 6 sessions on ONE calendar day. The day is the
// YYYY-MM-DD of the first session charged to that pass, not a 24-hour timer
// from purchase and not the purchase date. The other sessions must use that
// same date. Morning and afternoon sessions share the day. The end-of-day
// progress report is included for that bound date even after the 6 are used.
//
// Season Pass (CA$89.99): 48 sessions, at most 6 on one calendar day, and at
// most 8 distinct days. A day with only one session still uses one of the 8
// event days; leftover sessions on that pass can only be spent on the days
// already opened, up to 6 each. This is not a wallet of 48 anywhere-credits.
// Buying another Season Pass adds another grant with its own 8 days.
// The end-of-day progress report is included on any date.
//
// Which grant pays for a session:
//   1. Grandfathered unlimited (riders.plan season or pro already on the account).
//   2. An Event Pass already bound to that date, if it still has a session left.
//   3. A Season Pass that already has this date open and is under 6, or that
//      can still open a new event day.
//   4. An unbound Event Pass, which then binds to this date. It is not used to
//      buy a 7th session on a day the Season Pass already covers.
//   5. One flexible credit.
// A 7th session on a covered day needs a Single Report (or another flexible credit).
//
// Special Event Bundle (CA$59.99) is sold in person only. It has no product
// key, no Lemon Squeezy variant, and no webhook grant.

export const SINGLE_REPORT_CREDITS = 1;

export const PASS_SPECS = {
  event: { credits: 6, dailyCap: 6, maxDays: 1 },
  season: { credits: 48, dailyCap: 6, maxDays: 8 },
};

export const CHECKOUT_PRODUCT_KEYS = ['single', 'event', 'season'];

// Plans already stored on riders. Checkout must not write these anymore.
// 'pro' was never a Lemon Squeezy product; it shared the old unlimited check.
export const GRANDFATHERED_UNLIMITED_PLANS = ['season', 'pro'];

export const IN_PERSON_BUNDLE = Object.freeze({
  name: 'Special Event Bundle',
  priceCad: 59.99,
});

const MESSAGES = {
  out_of_credits: 'Out of tokens \u2014 please purchase from the Membership page or redeem a promo code from the menu.',
  daily_session_cap: 'This pass allows 6 sessions on one event day. A Single Report covers another session today.',
  season_days_exhausted: 'This Season Pass covers 8 event days. An Event Pass or a Single Report covers another day.',
  event_day_locked: 'This Event Pass is already in use on a different day.',
  session_date_required: 'An Event Pass or Season Pass needs the session date (YYYY-MM-DD) before it can be used.',
  day_report_not_included: 'The end-of-day progress report is included with an Event Pass (for that event day) or a Season Pass.',
};

// Calendar day of a session. Accepts YYYY-MM-DD or an ISO timestamp that
// starts with that date. The date prefix is the event day (a track day), not
// a conversion through UTC that could move an evening session to the next day.
export function normalizeSessionDay(value) {
  if (value == null) return null;
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function denialPayload(code, entitlement, extra = {}) {
  let message = MESSAGES[code] || MESSAGES.out_of_credits;
  if (code === 'event_day_locked' && extra?.boundDate) {
    message = `This Event Pass is for ${extra.boundDate}. A Single Report or another pass covers a different day.`;
  }
  const dayReport = code === 'day_report_not_included';
  return {
    error: dayReport ? 'Day progress report requires an Event Pass or Season Pass' : 'Out of tokens',
    code: MESSAGES[code] ? code : 'out_of_credits',
    paywall: true,
    reportCredits: entitlement?.reportCredits ?? 0,
    plan: entitlement?.plan || 'free',
    unlimited: Boolean(entitlement?.unlimited),
    canGenerate: Boolean(entitlement?.canGenerate),
    dayReport: entitlement?.dayReport || null,
    boundDate: extra?.boundDate || null,
    message,
  };
}
