'use strict';

// Canada's Anti-Spam Legislation (CASL) identification and unsubscribe helpers.
// Commercial email must name the sender, show a mailing address and a contact
// method, and include a working unsubscribe mechanism. Transactional mail
// (verification, password reset, reports, receipts) does not use this module's
// footer or List-Unsubscribe headers.

import crypto from 'crypto';
import config from './config.js';

export const BUSINESS_NAME = 'MotoTrackIQ';
export const MAILING_ADDRESS_PLACEHOLDER = '[Mailing address coming soon]';
export const MAILING_ADDRESS_WARNING =
  '[casl] BUSINESS_MAILING_ADDRESS is not set. Commercial email will show "[Mailing address coming soon]" until you set the physical mailing address CASL requires.';

const warnState = { sent: false };

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON boolean true, 1, "1", or "true" opt in. Everything else, including omitted, is false. */
export function parseMarketingConsent(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string' && /^(true|1)$/i.test(value.trim())) return true;
  return false;
}

export function contactEmail() {
  const from = process.env.FROM_EMAIL;
  return from && from.trim() ? from.trim() : 'info@mototrackiq.com';
}

export function mailingAddress() {
  const val = process.env.BUSINESS_MAILING_ADDRESS;
  if (val && val.trim()) return val.trim();
  return MAILING_ADDRESS_PLACEHOLDER;
}

/** Log once per process when the physical mailing address is missing. */
export function warnIfMailingAddressMissing() {
  if (process.env.BUSINESS_MAILING_ADDRESS?.trim()) return false;
  if (warnState.sent) return false;
  warnState.sent = true;
  console.warn(MAILING_ADDRESS_WARNING);
  return true;
}

export function resetMailingAddressWarningForTests() {
  warnState.sent = false;
}

function apiOrigin() {
  const raw = (process.env.API_PUBLIC_URL || process.env.FRONTEND_URL || 'https://mototrackiq.com').trim();
  return raw.replace(/\/+$/, '');
}

// Prefer a dedicated secret so rotating JWT_SECRET does not have to invalidate
// unsubscribe links. When unset, reuse the report-link secret (itself JWT_SECRET
// when REPORT_LINK_SECRET is unset). This does not change JWT_SECRET.
function unsubscribeSecret() {
  const dedicated = process.env.UNSUBSCRIBE_SECRET?.trim();
  if (dedicated) return dedicated;
  return config.reportLinkSecret;
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * Per-recipient HMAC token. No expiry: CASL requires the link in a message to
 * keep working, and a later click only withdraws consent (it is idempotent).
 * Payload is v1, rider id, and email, so a recreated account with the same
 * address can still be opted out.
 */
export function signUnsubscribeToken({ riderId, email } = {}) {
  const rid = riderId ? String(riderId) : '';
  const em = email ? String(email).trim().toLowerCase() : '';
  if (!rid && !em) throw new Error('riderId or email required');
  const payload = b64url(`v1\n${rid}\n${em}`);
  const sig = b64url(crypto.createHmac('sha256', unsubscribeSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyUnsubscribeToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payload || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', unsubscribeSecret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let subject;
  try {
    subject = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const lines = subject.split('\n');
  if (lines.length !== 3 || lines[0] !== 'v1') return null;
  const riderId = lines[1] || null;
  const email = lines[2] || null;
  if (!riderId && !email) return null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return { riderId, email };
}

export function buildUnsubscribeUrl(token) {
  return `${apiOrigin()}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function listUnsubscribeHeaders(unsubscribeUrl) {
  const url = String(unsubscribeUrl || '').replace(/[\r\n<>]+/g, '');
  return [
    `List-Unsubscribe: <${url}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  ];
}

export function caslFooterHtml(unsubscribeUrl) {
  warnIfMailingAddressMissing();
  const address = String(mailingAddress())
    .split(/\r?\n/)
    .map((line) => esc(line))
    .join('<br>');
  const email = esc(contactEmail());
  const link = unsubscribeUrl
    ? `<p style="margin:8px 0 0;"><a href="${esc(unsubscribeUrl)}" style="color:#38bdf8;text-decoration:underline;">Unsubscribe</a> from MotoTrackIQ marketing emails.</p>`
    : '';
  return `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #1f1f1f;text-align:center;color:#6b7280;font-size:12px;line-height:1.6;">
      <p style="margin:0;color:#9ca3af;font-weight:600;">${esc(BUSINESS_NAME)}</p>
      <p style="margin:4px 0 0;">${address}</p>
      <p style="margin:4px 0 0;">Contact: <a href="mailto:${email}" style="color:#38bdf8;text-decoration:none;">${email}</a></p>
      ${link}
    </div>`;
}
