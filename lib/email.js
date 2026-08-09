'use strict';

import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', 'config');

const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');

// OAuth-authenticated Gmail account that actually performs the send.
// Keep this as the account whose credentials/token live in config/ unless the
// token has been re-authorized against the Workspace mailbox.
const GMAIL_USER = process.env.GMAIL_USER || 'devonatworx@gmail.com';

// Public-facing From/Reply-To identity. For mail to truly send AS this address
// (and pass SPF/DKIM/DMARC), info@mototrackiq.com must either be:
//   (a) a verified "Send mail as" alias on GMAIL_USER's Gmail account, or
//   (b) the account the OAuth token was authorized against.
const FROM_EMAIL = process.env.FROM_EMAIL || 'info@mototrackiq.com';
const FROM_NAME  = process.env.FROM_NAME  || 'MotoTrackIQ';

// Where internal admin notifications (new signups, etc.) are delivered.
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'info@mototrackiq.com';

// Public-facing portal URL used to build verify / reset links in emails.
// Set FRONTEND_URL on Railway to the production portal (https://mototrackiq.com).
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://mototrackiq.com').replace(/\/+$/, '');

// Get a fresh authenticated Gmail API client
async function getGmailClient() {
  // OAuth client creds: prefer env (Railway), fall back to config/credentials.json (local dev).
  let client_id = process.env.GOOGLE_CLIENT_ID;
  let client_secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
    const inst = credentials.installed || credentials.web || credentials;
    client_id = client_id || inst.client_id;
    client_secret = client_secret || inst.client_secret;
  }

  // OAuth token: prefer env refresh token (Railway), fall back to config/token.json (local dev).
  let token;
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    token = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
  } else {
    token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  }

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost');
  oauth2Client.setCredentials(token);

  // Refresh access token. Persist to file only when using the local token file
  // (Railway's filesystem is ephemeral; the refresh_token in env is the source of truth).
  const { credentials: fresh } = await oauth2Client.refreshAccessToken();
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    try { writeFileSync(TOKEN_PATH, JSON.stringify({ ...token, ...fresh }, null, 2)); } catch { /* read-only fs */ }
  }

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Escape user-supplied text before injecting into HTML email bodies, so names
// or track labels containing < > & " ' render correctly (and can't break markup).
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// RFC 2047 encode a header value (Subject, display names) so non-ASCII chars
// (em-dash, emoji, accented names) survive. ASCII-only strings pass through.
function encodeHeader(str) {
  const s = String(str);
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// Encode an internal notification message. Sends FROM the OAuth-authenticated
// account (GMAIL_USER) so it always delivers, regardless of send-as alias state.
// Reply-To is set to info@ so replies still go to the business inbox.
function encodeInternalMessage(to, subject, htmlBody) {
  const msg = [
    `From: "${encodeHeader(FROM_NAME)}" <${GMAIL_USER}>`,
    `Reply-To: ${FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    htmlBody
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

// Encode an RFC 2822 email message for the Gmail API
function encodeMessage(to, subject, htmlBody) {
  const msg = [
    `From: "${encodeHeader(FROM_NAME)}" <${FROM_EMAIL}>`,
    `Reply-To: ${FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    htmlBody
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

// Encode an RFC 2822 message with a single binary attachment (multipart/mixed)
function encodeMessageWithAttachment(to, subject, htmlBody, attachment) {
  const boundary = 'mtiq_' + Math.random().toString(36).slice(2);
  const { filename, mimeType, content } = attachment; // content: Buffer
  const b64 = content.toString('base64').replace(/(.{76})/g, '$1\r\n');
  const msg = [
    `From: "${encodeHeader(FROM_NAME)}" <${FROM_EMAIL}>`,
    `Reply-To: ${FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlBody,
    '',
    `--${boundary}`,
    `Content-Type: ${mimeType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '',
    `--${boundary}--`,
    ''
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

// ── Shared HTML wrapper ───────────────────────────────────────────────────────

// Public URL where the brand logo is served. Transparent PNG (black background
// keyed out + cropped to the artwork) so it blends into the dark email header.
const LOGO_URL = process.env.LOGO_URL || `${FRONTEND_URL}/logo-email.png`;

// Dark-themed email shell that mirrors the mototrackiq.com site:
// black background, dark cards, orange (#f97316) accent, blue (#38bdf8) secondary,
// light text (#f9fafb), Inter/system font stack. Uses the site logo in the header.
function htmlWrap(title, bodyContent) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#000000;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px;">
    <!-- Header -->
    <div style="background:#0d0d0d;padding:34px 30px 30px;text-align:center;border-radius:14px 14px 0 0;border:1px solid #1f1f1f;border-bottom:none;">
      <img src="${LOGO_URL}" alt="MotoTrackIQ" width="300" style="height:auto;max-width:300px;width:100%;display:inline-block;">
      <p style="color:#38bdf8;margin:16px 0 0;font-size:13px;letter-spacing:1px;font-weight:600;">AI TRACK DAY ANALYTICS</p>
    </div>
    <!-- Body -->
    <div style="background:#0d0d0d;padding:32px 30px;border-radius:0 0 14px 14px;border:1px solid #1f1f1f;border-top:none;">
      ${bodyContent}
    </div>
    <!-- Footer -->
    <div style="text-align:center;padding:20px 16px;color:#6b7280;font-size:12px;line-height:1.6;">
      <p style="margin:0 0 4px;">&copy; ${new Date().getFullYear()} <span style="color:#f97316;font-weight:600;">MotoTrackIQ</span></p>
      <p style="margin:0;"><a href="${FRONTEND_URL}" style="color:#38bdf8;text-decoration:none;">mototrackiq.com</a></p>
    </div>
  </div>
</body>
</html>`;
}

// ── Public email functions ───────────────────────────────────────────────────

// Sent once an account is fully set up (email verified + password set).
// Confirms the account is active and summarizes the account info. No password
// is included — the rider set their own during verification.
export async function sendWelcomeEmail(to, firstName, account = {}) {
  try {
    const gmail = await getGmailClient();
    const loginUrl = `${FRONTEND_URL}/?login=1`;
    const planLabel = ({ free: 'Free', per_event: 'Per-Event', season: 'Season', pro: 'Pro' })[account.plan] || 'Not selected yet';
    const rows = [
      ['Name', `${firstName || ''} ${account.lastName || ''}`.trim() || '—'],
      ['Email', to],
      account.primaryTrack ? ['Home track', account.primaryTrack] : null,
      account.experience ? ['Experience', account.experience] : null,
      ['Membership', planLabel],
    ].filter(Boolean).map(([k, v]) =>
      `<tr><td style="padding:10px 14px;color:#6b7280;width:130px;">${esc(k)}</td><td style="padding:10px 14px;color:#f9fafb;font-weight:600;">${esc(v)}</td></tr>`
    ).join('');
    const html = htmlWrap('Welcome to MotoTrackIQ', `
      <h2 style="color:#f9fafb;margin-bottom:16px;font-size:1.4rem;">You're all set, ${esc(firstName || 'rider')}! 🏍️</h2>
      <p style="color:#9ca3af;line-height:1.7;margin-bottom:18px;">
        Your <strong style="color:#f9fafb;">MotoTrackIQ</strong> account is active and ready to go. Here are your account details:
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;background:#161616;border:1px solid #1f1f1f;border-radius:8px;overflow:hidden;margin-bottom:22px;">
        ${rows}
      </table>
      <p style="color:#9ca3af;line-height:1.7;margin-bottom:22px;">
        Sign in any time to upload your session data and get AI-powered lap reports, speed traces, and coaching insights.
      </p>
      <a href="${loginUrl}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;">
        Sign in to MotoTrackIQ &rarr;
      </a>
      <p style="color:#6b7280;font-size:13px;margin-top:24px;">
        If the button doesn't work, copy and paste this into your browser:<br>
        <span style="word-break:break-all;color:#38bdf8;">${loginUrl}</span>
      </p>
      <p style="color:#6b7280;font-size:13px;margin-top:18px;">
        Questions? Just reply to this email — it reaches us at info@mototrackiq.com.
      </p>
    `);
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeMessage(to, 'Welcome to MotoTrackIQ — your account is ready', html) } });
    return { success: true };
  } catch (err) {
    console.error('sendWelcomeEmail error:', err.message);
    return { success: false, error: err.message };
  }
}

export async function sendVerifyEmail(to, firstName, verifyToken, email) {
  try {
    const gmail = await getGmailClient();
    const verifyUrl = `${FRONTEND_URL}/?verify=${verifyToken}&email=${encodeURIComponent(email)}`;
    const html = htmlWrap('Confirm your email — MotoTrackIQ', `
      <h2 style="color:#f9fafb;margin-bottom:16px;font-size:1.4rem;">Almost there${firstName ? `, ${esc(firstName)}` : ''}! 🏁</h2>
      <p style="color:#9ca3af;line-height:1.7;margin-bottom:14px;">
        Thanks for signing up for <strong style="color:#f9fafb;">MotoTrackIQ</strong>. Confirm your email to activate your account and set your password.
      </p>
      <p style="color:#9ca3af;line-height:1.7;margin-bottom:6px;">
        Confirming also opts you in to occasional MotoTrackIQ updates. This link expires in <strong style="color:#f9fafb;">48 hours</strong>.
      </p>
      <p style="color:#6b7280;font-size:13px;margin-bottom:24px;">
        If you didn't sign up, you can safely ignore this email.
      </p>
      <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;">
        Confirm Email &amp; Set Password &rarr;
      </a>
      <p style="color:#999;font-size:13px;margin-top:24px;">
        If the button doesn't work, copy and paste this into your browser:<br>
        <span style="word-break:break-all;color:#38bdf8;">${verifyUrl}</span>
      </p>
    `);
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeMessage(to, 'Confirm your email — MotoTrackIQ', html) } });
    return { success: true };
  } catch (err) {
    console.error('sendVerifyEmail error:', err.message);
    return { success: false, error: err.message };
  }
}

export async function sendPasswordResetEmail(to, firstName, resetToken, email) {
  try {
    const gmail = await getGmailClient();
    const resetUrl = `${FRONTEND_URL}/?reset=${resetToken}&email=${encodeURIComponent(email)}`;
    const html = htmlWrap('Reset Your MotoTrackIQ Password', `
      <h2 style="color:#f9fafb;margin-bottom:16px;font-size:1.4rem;">Password Reset, ${esc(firstName)}</h2>
      <p style="color:#9ca3af;line-height:1.7;margin-bottom:14px;">
        We received a request to reset your MotoTrackIQ password. Click the button below to set a new one.
      </p>
      <p style="color:#9ca3af;line-height:1.7;margin-bottom:6px;">
        This link expires in <strong style="color:#f9fafb;">1 hour</strong> and can only be used once.
      </p>
      <p style="color:#6b7280;font-size:13px;margin-bottom:24px;">
        If you didn't request this, you can safely ignore this email — your account is still secure.
      </p>
      <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;">
        Reset My Password &rarr;
      </a>
      <p style="color:#999;font-size:13px;margin-top:24px;">
        If the button doesn't work, copy and paste this into your browser:<br>
        <span style="word-break:break-all;color:#38bdf8;">${resetUrl}</span>
      </p>
    `);
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeMessage(to, 'Reset Your MotoTrackIQ Password', html) } });
    return { success: true };
  } catch (err) {
    console.error('sendPasswordResetEmail error:', err.message);
    return { success: false, error: err.message };
  }
}

// Double opt-in confirmation sent TO the person who joined the waitlist.
// Confirms their email is real and captures explicit consent to communication.
export async function sendBetaConfirmEmail(to, firstName, confirmToken) {
  try {
    const gmail = await getGmailClient();
    const confirmUrl = `${FRONTEND_URL}/?confirm=${confirmToken}&email=${encodeURIComponent(to)}`;
    const html = htmlWrap('Confirm your spot — MotoTrackIQ Beta', `
      <h2 style="color:#f9fafb;margin-bottom:16px;font-size:1.4rem;">One quick step${firstName ? `, ${esc(firstName)}` : ''} 🏁</h2>
      <p style="color:#9ca3af;line-height:1.7;margin-bottom:14px;">
        Thanks for joining the <strong style="color:#f9fafb;">MotoTrackIQ</strong> beta waitlist! Confirm your email to lock in your spot.
      </p>
      <p style="color:#9ca3af;line-height:1.7;margin-bottom:6px;">
        <strong style="color:#f9fafb;">By confirming, you consent to receive email communication from MotoTrackIQ</strong> (launch updates, beta invites, and product news). You can unsubscribe at any time. This link expires in <strong style="color:#f9fafb;">7 days</strong>.
      </p>
      <p style="color:#6b7280;font-size:13px;margin-bottom:24px;">
        If you didn't sign up, you can safely ignore this email — nothing further will happen.
      </p>
      <a href="${confirmUrl}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;">
        Confirm My Spot &rarr;
      </a>
      <p style="color:#999;font-size:13px;margin-top:24px;">
        If the button doesn't work, copy and paste this into your browser:<br>
        <span style="word-break:break-all;color:#38bdf8;">${confirmUrl}</span>
      </p>
    `);
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeMessage(to, 'Confirm your spot — MotoTrackIQ Beta', html) } });
    return { success: true };
  } catch (err) {
    console.error('sendBetaConfirmEmail error:', err.message);
    return { success: false, error: err.message };
  }
}

export async function sendBetaSignupNotification(data) {
  try {
    const gmail = await getGmailClient();
    const html = htmlWrap('New Beta Signup — MotoTrackIQ', `
      <h2 style="color:#f9fafb;margin-bottom:20px;font-size:1.4rem;">🎉 New Beta Signup</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;background:#161616;border:1px solid #1f1f1f;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:10px 14px;color:#6b7280;width:120px;">Name</td><td style="padding:10px 14px;font-weight:600;color:#f9fafb;">${data.firstName} ${data.lastName}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;">Email</td><td style="padding:10px 14px;"><a href="mailto:${data.email}" style="color:#38bdf8;">${data.email}</a></td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;">Bike</td><td style="padding:10px 14px;color:#f9fafb;">${data.bike || '—'}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;">Track</td><td style="padding:10px 14px;color:#f9fafb;">${data.track || '—'}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;">Experience</td><td style="padding:10px 14px;color:#f9fafb;">${data.experience || '—'}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;">Source</td><td style="padding:10px 14px;color:#f9fafb;">${data.source || 'direct'}</td></tr>
      </table>
    `);
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeInternalMessage(NOTIFY_EMAIL, `New Beta Signup: ${data.firstName} ${data.lastName}`, html) } });
    return { success: true };
  } catch (err) {
    console.error('sendBetaSignupNotification error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Track-day report email (with PDF attachment + specials) ──────────────

function fmtLap(t) {
  if (t === null || t === undefined || isNaN(t)) return '—';
  const m = Math.floor(t / 60);
  const s = (t % 60);
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/**
 * Email a generated PDF track-day report to a rider.
 * @param {string} to recipient email
 * @param {string} riderName
 * @param {Buffer} pdfBuffer the generated report PDF
 * @param {object} analysis the analyzeCSV() result (for the email summary)
 * @param {object} [opts] { specials: bool }
 */
export async function sendReportEmail(to, riderName, pdfBuffer, analysis, opts = {}) {
  try {
    const gmail = await getGmailClient();
    const sum = analysis?.summary || {};
    const stats = analysis?.lapStats || {};
    const metrics = analysis?.metrics || {};
    const track = sum.trackName || 'your session';
    const filename = `MotoTrackIQ-Report-${(track || 'session').replace(/[^a-z0-9]+/gi, '-')}.pdf`;

    const specialsBlock = opts.specials === false ? '' : `
      <div style="margin-top:28px;background:#161616;border:1px solid #f97316;border-radius:10px;padding:20px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#f97316;text-transform:uppercase;">Early-Rider Special</div>
        <h3 style="color:#f9fafb;margin:6px 0 8px;font-size:1.15rem;">Get full-season analytics on your bike</h3>
        <p style="color:#9ca3af;line-height:1.6;margin:0 0 14px;font-size:14px;">
          You're looking at one session. Imagine every track day auto-analyzed — lap-by-lap coaching, sector deltas,
          lean &amp; braking traces, and a track map for every corner. <strong style="color:#f9fafb;">Beta riders get it free for the 2026 season.</strong>
        </p>
        <a href="https://mototrackiq.com" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:700;font-size:.95rem;">
          Claim my beta spot &rarr;
        </a>
      </div>`;

    const html = htmlWrap('Your MotoTrackIQ Track Day Report', `
      <h2 style="color:#f9fafb;margin-bottom:8px;font-size:1.4rem;">Your report is ready${riderName ? `, ${esc(riderName)}` : ''} 🏍️</h2>
      <p style="color:#9ca3af;line-height:1.7;margin-bottom:18px;">
        We analyzed your data from <strong style="color:#f9fafb;">${track}</strong>. The full breakdown is attached as a PDF.
        Here's the quick look:
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;background:#161616;border:1px solid #1f1f1f;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:10px 14px;color:#6b7280;width:150px;">Track</td><td style="padding:10px 14px;font-weight:600;color:#f9fafb;">${track}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;">Best Lap</td><td style="padding:10px 14px;font-weight:700;color:#f97316;">${fmtLap(stats.best)}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;">Laps</td><td style="padding:10px 14px;color:#f9fafb;">${stats.count ?? sum.lapCount ?? '—'}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;">Consistency</td><td style="padding:10px 14px;color:#f9fafb;">${stats.consistency || '—'}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;">Top Speed</td><td style="padding:10px 14px;color:#f9fafb;">${metrics.maxSpeed ? metrics.maxSpeed.toFixed(0) + ' km/h' : '—'}</td></tr>
      </table>
      <p style="color:#6b7280;font-size:13px;margin-top:16px;">📎 Full report attached: <strong style="color:#9ca3af;">${filename}</strong></p>
      ${specialsBlock}
      <p style="color:#6b7280;font-size:11px;line-height:1.6;margin-top:20px;border-top:1px solid #1f1f1f;padding-top:12px;">
        <strong style="color:#9ca3af;">Safety &amp; liability notice:</strong> AI coaching insights are general, informational
        observations generated from your data &mdash; not professional riding instruction. A note such as
        &ldquo;brake later&rdquo; describes your data, not an instruction to do so on track. Do not change your riding
        unless you independently judge it safe and within your ability. Acting on any insight is entirely at your own
        risk; MotoTrackIQ is not liable for any resulting injury or loss. See
        <a href="https://mototrackiq.com/terms" style="color:#f97316;">mototrackiq.com/terms</a>.
      </p>
    `);

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodeMessageWithAttachment(to, `Your MotoTrackIQ Report — ${track}`, html, {
          filename,
          mimeType: 'application/pdf',
          content: pdfBuffer
        })
      }
    });
    return { success: true };
  } catch (err) {
    console.error('sendReportEmail error:', err.message);
    return { success: false, error: err.message };
  }
}
