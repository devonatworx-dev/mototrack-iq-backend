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

// Encode an internal notification message. Sends FROM the OAuth-authenticated
// account (GMAIL_USER) so it always delivers, regardless of send-as alias state.
// Reply-To is set to info@ so replies still go to the business inbox.
function encodeInternalMessage(to, subject, htmlBody) {
  const msg = [
    `From: "${FROM_NAME}" <${GMAIL_USER}>`,
    `Reply-To: ${FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: ${subject}`,
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
    `From: "${FROM_NAME}" <${FROM_EMAIL}>`,
    `Reply-To: ${FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: ${subject}`,
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
    `From: "${FROM_NAME}" <${FROM_EMAIL}>`,
    `Reply-To: ${FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: ${subject}`,
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

function htmlWrap(title, bodyContent) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px 0;">
    <div style="background:#1a1a2e;padding:30px;text-align:center;border-radius:12px 12px 0 0;">
      <h1 style="color:#f97316;margin:0;font-size:1.8rem;">MotoTrackIQ</h1>
      <p style="color:#38bdf8;margin:5px 0 0;font-size:.9rem;">AI Track Day Analytics</p>
    </div>
    <div style="background:#fff;padding:30px;border-radius:0 0 12px 12px;border:1px solid #e5e5e5;border-top:none;">
      ${bodyContent}
    </div>
    <div style="text-align:center;padding:16px;color:#999;font-size:12px;">
      &copy; ${new Date().getFullYear()} MotoTrackIQ
    </div>
  </div>
</body>
</html>`;
}

// ── Public email functions ───────────────────────────────────────────────────

export async function sendWelcomeEmail(to, firstName, password) {
  try {
    const gmail = await getGmailClient();
    const html = htmlWrap('Welcome to MotoTrackIQ', `
      <h2 style="color:#333;margin-bottom:16px;">Welcome, ${firstName}!</h2>
      <p style="color:#555;line-height:1.7;margin-bottom:14px;">
        Thanks for joining <strong>MotoTrackIQ</strong>. Your account is ready and you're officially on the beta waitlist!
      </p>
      <p style="color:#555;line-height:1.7;margin-bottom:14px;">
        Your temporary password is:<br>
        <strong style="font-size:1.2rem;color:#f97316;background:#fff3eb;padding:8px 14px;border-radius:6px;display:inline-block;margin-top:6px;">${password}</strong>
      </p>
      <p style="color:#555;line-height:1.7;margin-bottom:24px;">
        Please log in and change your password as soon as possible.
      </p>
      <a href="http://192.168.1.77:3015" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;">
        Go to MotoTrackIQ &rarr;
      </a>
      <p style="color:#999;font-size:13px;margin-top:24px;">
        If the button doesn't work, copy and paste this into your browser:<br>
        <span style="word-break:break-all;color:#38bdf8;">http://192.168.1.77:3015</span>
      </p>
    `);
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeMessage(to, 'Welcome to MotoTrackIQ!', html) } });
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
      <h2 style="color:#333;margin-bottom:16px;">Almost there${firstName ? `, ${firstName}` : ''}! 🏁</h2>
      <p style="color:#555;line-height:1.7;margin-bottom:14px;">
        Thanks for signing up for <strong>MotoTrackIQ</strong>. Confirm your email to activate your account and set your password.
      </p>
      <p style="color:#555;line-height:1.7;margin-bottom:6px;">
        Confirming also opts you in to occasional MotoTrackIQ updates. This link expires in <strong>48 hours</strong>.
      </p>
      <p style="color:#999;font-size:13px;margin-bottom:24px;">
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
      <h2 style="color:#333;margin-bottom:16px;">Password Reset, ${firstName}</h2>
      <p style="color:#555;line-height:1.7;margin-bottom:14px;">
        We received a request to reset your MotoTrackIQ password. Click the button below to set a new one.
      </p>
      <p style="color:#555;line-height:1.7;margin-bottom:6px;">
        This link expires in <strong>1 hour</strong> and can only be used once.
      </p>
      <p style="color:#999;font-size:13px;margin-bottom:24px;">
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
    const confirmUrl = `${FRONTEND_URL}/?confirm=${confirmToken}`;
    const html = htmlWrap('Confirm your spot — MotoTrackIQ Beta', `
      <h2 style="color:#333;margin-bottom:16px;">One quick step${firstName ? `, ${firstName}` : ''} 🏁</h2>
      <p style="color:#555;line-height:1.7;margin-bottom:14px;">
        Thanks for joining the <strong>MotoTrackIQ</strong> beta waitlist! Confirm your email to lock in your spot and opt in to launch updates.
      </p>
      <p style="color:#999;font-size:13px;margin-bottom:24px;">
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
      <h2 style="color:#333;margin-bottom:20px;">🎉 New Beta Signup</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#999;width:120px;">Name</td><td style="padding:8px 0;font-weight:600;">${data.firstName} ${data.lastName}</td></tr>
        <tr><td style="padding:8px 0;color:#999;">Email</td><td style="padding:8px 0;"><a href="mailto:${data.email}" style="color:#38bdf8;">${data.email}</a></td></tr>
        <tr><td style="padding:8px 0;color:#999;">Bike</td><td style="padding:8px 0;">${data.bike || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#999;">Track</td><td style="padding:8px 0;">${data.track || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#999;">Experience</td><td style="padding:8px 0;">${data.experience || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#999;">Source</td><td style="padding:8px 0;">${data.source || 'direct'}</td></tr>
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
      <div style="margin-top:28px;background:linear-gradient(135deg,#fff7ed,#ffedd5);border:1px solid #fed7aa;border-radius:10px;padding:20px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#ea580c;text-transform:uppercase;">Early-Rider Special</div>
        <h3 style="color:#1a1a2e;margin:6px 0 8px;font-size:1.15rem;">Get full-season analytics on your bike</h3>
        <p style="color:#555;line-height:1.6;margin:0 0 14px;font-size:14px;">
          You're looking at one session. Imagine every track day auto-analyzed — lap-by-lap coaching, sector deltas,
          lean &amp; braking traces, and a track map for every corner. <strong>Beta riders get it free for the 2026 season.</strong>
        </p>
        <a href="https://mototrackiq.com" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:700;font-size:.95rem;">
          Claim my beta spot &rarr;
        </a>
      </div>`;

    const html = htmlWrap('Your MotoTrackIQ Track Day Report', `
      <h2 style="color:#333;margin-bottom:8px;">Your report is ready${riderName ? `, ${riderName}` : ''} 🏍️</h2>
      <p style="color:#555;line-height:1.7;margin-bottom:18px;">
        We analyzed your data from <strong>${track}</strong>. The full breakdown is attached as a PDF.
        Here's the quick look:
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fafafa;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:10px 14px;color:#999;width:150px;">Track</td><td style="padding:10px 14px;font-weight:600;">${track}</td></tr>
        <tr><td style="padding:10px 14px;color:#999;">Best Lap</td><td style="padding:10px 14px;font-weight:700;color:#ea580c;">${fmtLap(stats.best)}</td></tr>
        <tr><td style="padding:10px 14px;color:#999;">Laps</td><td style="padding:10px 14px;">${stats.count ?? sum.lapCount ?? '—'}</td></tr>
        <tr><td style="padding:10px 14px;color:#999;">Consistency</td><td style="padding:10px 14px;">${stats.consistency || '—'}</td></tr>
        <tr><td style="padding:10px 14px;color:#999;">Top Speed</td><td style="padding:10px 14px;">${metrics.maxSpeed ? metrics.maxSpeed.toFixed(0) + ' km/h' : '—'}</td></tr>
      </table>
      <p style="color:#777;font-size:13px;margin-top:16px;">📎 Full report attached: <strong>${filename}</strong></p>
      ${specialsBlock}
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
