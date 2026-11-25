'use strict';

import express from 'express';
import { caslFooterHtml, contactEmail, verifyUnsubscribeToken } from '../lib/casl.js';
import { withdrawMarketingConsent } from '../lib/db.js';

const router = express.Router();

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page({ ok }) {
  const title = ok ? 'You are unsubscribed' : 'Unsubscribe link not valid';
  const lead = ok
    ? 'MotoTrackIQ will no longer send you marketing email. Track day tips, offers, and news stop here.'
    : 'This unsubscribe link is not valid. No change was made.';
  const extra = ok
    ? 'Account email is unchanged. Verification, password reset, reports, and receipts still send when you ask for them.'
    : `If you still want to stop marketing email, contact ${esc(contactEmail())}.`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title} — MotoTrackIQ</title>
</head>
<body style="margin:0;background:#000;color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <main style="max-width:560px;margin:0 auto;padding:48px 20px;">
    <h1 style="font-size:1.6rem;margin:0 0 12px;">${title}</h1>
    <p style="color:#9ca3af;line-height:1.6;margin:0 0 12px;">${lead}</p>
    <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">${extra}</p>
    ${caslFooterHtml('')}
  </main>
</body>
</html>`;
}

function applyToken(token) {
  const parsed = verifyUnsubscribeToken(token);
  if (!parsed) return { ok: false, status: 400 };
  withdrawMarketingConsent({ riderId: parsed.riderId, email: parsed.email });
  return { ok: true, status: 200 };
}

function send(res, result) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex');
  res.status(result.status).send(page(result));
}

// One click from a person, and the POST mailbox providers send for
// List-Unsubscribe-Post. Both withdraw marketing consent immediately.
router.get('/unsubscribe', (req, res) => {
  send(res, applyToken(req.query.token));
});

router.post('/unsubscribe', (req, res) => {
  const token = req.query.token || req.body?.token;
  send(res, applyToken(token));
});

export default router;
