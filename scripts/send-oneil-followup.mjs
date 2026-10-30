import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import { encodeMessage, htmlWrap, FROM_EMAIL } from '../lib/email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', 'config');

const TO = 'tlrc51r@gmail.com';
const FIRST = 'Oneil';
const SUBJECT = 'Oneil — your 4 MotoTrackIQ report credits are ready';
const LOGIN_URL = 'https://mototrackiq.com/?login=1';

// ── Body ──────────────────────────────────────────────────────────────────────
// FACTS (verified 2026-10-29 against prod):
//   - 4 credits = 1 default + 3 from promo VRRA2026SEASON (usedCount=1 = him)
//   - sessions=0, reportsGenerated=0, 0 replies, temp password still valid
//   - waitlist row track = NULL, bike = "Bmw M1000RR", experience = advanced
// The earlier draft said "you signed up ... at Shannonville". That was WRONG —
// the waitlist row has no track on it. Never claim a track we don't have.
const body = `
      <h2 style="color:#f9fafb;margin-bottom:16px;font-size:1.4rem;">Hi ${FIRST} — your credits are ready 🏍️</h2>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:18px;">
        You signed up for MotoTrackIQ back on October 23, and your account is set up with
        <strong style="color:#f97316;">4 report credits ready to use</strong> — including the
        3-credit VRRA member bonus.
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:18px;">
        Nothing has been uploaded yet, so those credits are still sitting there waiting on
        a session from your M1000RR.
      </p>

      <h3 style="color:#f9fafb;font-size:1rem;margin:0 0 12px;">Getting your first lap report</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:12px;">
        1. Sign in at <a href="${LOGIN_URL}" style="color:#38bdf8;">${LOGIN_URL}</a>
        using <strong style="color:#9ca3af;">${TO}</strong>
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:12px;">
        2. Use the <strong style="color:#9ca3af;">temporary password from my October 23
        "sign-in details" email</strong> — then change it to your own under
        <strong style="color:#9ca3af;">Settings</strong>
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:12px;">
        3. <strong style="color:#9ca3af;">Sessions → Upload Session</strong> and drop in your
        data logger CSV (AiM, Garmin, RaceCapture, and so on)
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:18px;">
        4. Hit <strong style="color:#9ca3af;">Generate Report</strong> — each report uses one credit
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:18px;">
        Lost the temporary password? Just reply to this email and I'll send you a fresh
        reset link — you don't need the old one.
      </p>

      <h3 style="color:#f9fafb;font-size:1rem;margin:0 0 12px;">One thing worth knowing</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:12px;">
        MotoTrackIQ gives you your <strong style="color:#9ca3af;">GPS speed-heat racing line</strong> —
        the line you actually rode around the circuit, coloured by speed — plus a per-lap
        breakdown of where you were carrying speed and where you were braking. It's a different
        read on your track day than a lap timer gives you.
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:18px;">
        The map needs GPS points in your logger export. If your file is telemetry-only, upload
        it anyway and I'll regenerate the map from it.
      </p>

      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:18px;">
        🎯 <strong style="color:#9ca3af;">Your next track day?</strong> Upload that session and
        you'll have the report before you get home.
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:22px;">
        If something isn't working, or the upload isn't behaving on your phone — reply to this
        email and tell me what happened. I built this and I want it working for you.
      </p>

      <a href="${LOGIN_URL}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;">
        Sign in to MotoTrackIQ →
      </a>
      <p style="color:#6b7280;font-size:13px;margin-top:24px;">
        If the button doesn't work, copy and paste this into your browser:<br>
        <span style="word-break:break-all;color:#38bdf8;">${LOGIN_URL}</span>
      </p>
      <p style="color:#6b7280;font-size:13px;margin-top:18px;">
        Questions? Just reply to this email — it reaches us at ${FROM_EMAIL}.
      </p>
`;

const html = htmlWrap('MotoTrackIQ — your credits are ready', body);

// ── Preflight ─────────────────────────────────────────────────────────────────
const checks = {
  'logo present'            : /logo-email\.png/.test(html),
  'CTA gradient button'     : /linear-gradient\(135deg,#f97316/.test(html),
  'login deep link'         : /mototrackiq\.com\/\?login=1/.test(html),
  'temp-password wording'   : /temporary password from my October 23/i.test(html),
  'forgot-password offer'   : /Lost the temporary password/i.test(html),
  'no Shannonville claim'   : !/Shannonville/i.test(html),
  'no dead set-pw link'     : !/set your password|create your password/i.test(html),
  'no mojibake'             : !/Ã¢Â€Â/.test(html),
  'no unescaped entities'   : /&(mdash|nbsp|amp);/.test(html) === false,
  '4 credits stated'        : /4 report credits/.test(html),
  'VRRA bonus mentioned'    : /VRRA member bonus/.test(html)
};

console.log('=== PREFLIGHT ===');
let failures = 0;
for (const [k, v] of Object.entries(checks)) {
  if (!v) failures++;
  console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
}
if (failures) { console.log(`\nABORT: ${failures} preflight failure(s).`); process.exit(1); }

if (process.env.DRY_RUN === '1') {
  writeFileSync('/tmp/oneil-followup.html', html);
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 620, height: 900 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1200));
  const logo = await page.evaluate(() => {
    const i = document.querySelector('img');
    return i ? i.naturalWidth : 0;
  });
  await page.screenshot({ path: '/tmp/oneil-followup.png', fullPage: true });
  console.log(`\n  logo naturalWidth: ${logo} ${logo > 0 ? '(PASS)' : '(FAIL)'}`);
  console.log('  page errors:', errs.length ? errs.slice(0, 3) : 'none');
  console.log('  screenshot: /tmp/oneil-followup.png');
  await browser.close();
  console.log('\nDRY RUN — not sent.');
  process.exit(0);
}

// ── Send ──────────────────────────────────────────────────────────────────────
const creds = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'credentials.json'), 'utf8'));
const inst = creds.installed || creds.web || creds;
const tok = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'token.json'), 'utf8'));
const auth = new google.auth.OAuth2(inst.client_id, inst.client_secret, 'http://localhost');
auth.setCredentials(tok);
const gmail = google.gmail({ version: 'v1', auth });

const res = await gmail.users.messages.send({
  userId: 'me',
  requestBody: { raw: encodeMessage(TO, SUBJECT, html) }
});
console.log('\nSENT:', JSON.stringify({ id: res.data.id, threadId: res.data.threadId }));
console.log('to:', TO, '| from:', FROM_EMAIL, '| subject:', SUBJECT);
