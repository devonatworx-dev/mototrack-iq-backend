'use strict';

// ── Signed report-link tokens ────────────────────────────────────────────────
// The report PDF route (GET /api/device/sessions/:id/report) is fetched via plain
// browser navigation (window.location.href / <a> click), which cannot carry an
// Authorization header. To avoid leaving it wide open (any leaked session UUID =
// public report), we require a short-lived, tamper-proof token in the query string:
//
//   /api/device/sessions/:id/report?token=<base64url(payload)>.<hmac>
//
// The token is an HMAC-SHA256 signature over `${sessionId}.${exp}`, so it:
//   - can only be minted by the server (needs the secret),
//   - is bound to ONE session id (can't be reused for another report),
//   - expires (default 24h), so leaked links die on their own.
//
// Re-downloading an already-generated report is FREE (no credit burn) — the credit
// was consumed when the report was first generated via /api/sessions/:id/report.

import crypto from 'crypto';
import config from './config.js';

// Required secret, no public fallback. The old chain ended in
// a literal that is committed to a public repo —
// that made report links forgeable for anyone who read the source.
const SECRET = config.reportLinkSecret;

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(data) {
  return b64url(crypto.createHmac('sha256', SECRET).update(data).digest());
}

// Mint a signed token for a session id. Returns the token string.
export function signReportToken(sessionId, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds | 0);
  const payload = b64url(`${sessionId}.${exp}`);
  const sig = sign(`${sessionId}.${exp}`);
  return `${payload}.${sig}`;
}

// Build a full relative URL a browser can navigate to.
export function signReportUrl(sessionId, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const token = signReportToken(sessionId, ttlSeconds);
  return `/api/device/sessions/${encodeURIComponent(sessionId)}/report?token=${token}`;
}

// Verify a token against a session id. Returns { ok, reason }.
export function verifyReportToken(sessionId, token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sig] = parts;
  let decoded;
  try {
    decoded = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const dot = decoded.lastIndexOf('.');
  if (dot < 0) return { ok: false, reason: 'malformed' };
  const sid = decoded.slice(0, dot);
  const exp = parseInt(decoded.slice(dot + 1), 10);
  if (!sid || !Number.isFinite(exp)) return { ok: false, reason: 'malformed' };

  // Constant-time signature check.
  const expectedSig = sign(`${sid}.${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (sid !== String(sessionId)) return { ok: false, reason: 'wrong_session' };
  if (Math.floor(Date.now() / 1000) > exp) return { ok: false, reason: 'expired' };
  return { ok: true };
}
