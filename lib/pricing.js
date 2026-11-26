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
// Event Pass (CA$19.99): 6 session credits. They are not locked to one day
// and they are not bound to the first session date. The 6 can be spent on
// one day or spread across days. There is no per-day cap beyond the 6.
//
// Season Pass (CA$89.99): 48 sessions, at most 6 on one calendar day, and at
// most 8 distinct days. A day with only one session still uses one of the 8
// event days; leftover sessions on that pass can only be spent on the days
// already opened, up to 6 each. This is not a wallet of 48 anywhere-credits.
// Buying another Season Pass adds another grant with its own 8 days.
//
// End-of-day summary: included for an Event Pass holder, a Season Pass holder,
// or a grandfathered unlimited plan, on any date that already has at least
// two saved sessions. Holding the pass is enough after the credits are used.
//
// Which grant pays for a session:
//   1. Grandfathered unlimited (riders.plan season or pro already on the account).
//   2. A Season Pass that already has this date open and is under 6, or that
//      can still open a new event day. A Season Pass still needs a session date.
//   3. An Event Pass credit, on any date, with no day binding.
//   4. One flexible credit.
// A 7th session on a Season day uses an Event Pass credit or a Single Report.
//
// Special Event Bundle (CA$59.99) is sold in person only. It has no product
// key, no Lemon Squeezy variant, and no webhook grant.

export const SINGLE_REPORT_CREDITS = 1;

export const DAY_REPORT_MIN_SESSIONS = 2;

// dailyCap and maxDays of 0 mean the pass is not limited by day.
export const PASS_SPECS = {
  event: { credits: 6, dailyCap: 0, maxDays: 0 },
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
  daily_session_cap: 'This Season Pass allows 6 sessions on one event day. An Event Pass or a Single Report covers another session today.',
  season_days_exhausted: 'This Season Pass covers 8 event days. An Event Pass or a Single Report covers another day.',
  session_date_required: 'A Season Pass needs the session date (YYYY-MM-DD) before it can be used.',
  day_report_not_included: 'The end-of-day summary is included with an Event Pass or a Season Pass.',
  day_report_needs_multiple_sessions: 'Save at least two sessions on this date to generate the end-of-day summary.',
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
  const message = MESSAGES[code] || MESSAGES.out_of_credits;
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
    message,
  };
}

// The rider holds a pass, but this date does not have two saved sessions yet.
// 400, not a paywall: buying another pass does not replace the missing session.
export function dayReportTooFewPayload(entitlement, sessionCount, date) {
  return {
    error: 'A day summary needs at least two sessions on that date',
    code: 'day_report_needs_multiple_sessions',
    paywall: false,
    sessionCount: Number(sessionCount) || 0,
    minimumSessions: DAY_REPORT_MIN_SESSIONS,
    date: date || null,
    dayReport: entitlement?.dayReport || null,
    message: MESSAGES.day_report_needs_multiple_sessions,
  };
}
