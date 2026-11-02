// Verifies the beta-invite validation send on the wire: decodes the raw
// Subject header (RFC 2047) and renders the real HTML in headless Chrome.
//
// This is a per-recipient check, so it is parameterised rather than hardcoded
// (the committed render-sent-email.mjs hardcodes one rider and its assertions).
//
// Usage: node scripts/verify-beta-invite-send.mjs <recipient-email> "<subject fragment>"

import { google } from 'googleapis';
import { readFileSync } from 'fs';
import puppeteer from 'puppeteer-core';

const base = '/home/assistant/.openclaw/workspace/mototrack-iq-backend-v2';
const to = process.argv[2] || 'eacooke10@gmail.com';
const subjectFragment = process.argv[3] || 'MotoTrackIQ follow-up';

const creds = JSON.parse(readFileSync(base + '/config/credentials.json', 'utf8'));
const inst = creds.installed || creds.web || creds;
const token = JSON.parse(readFileSync(base + '/config/token.json', 'utf8'));
const o = new google.auth.OAuth2(inst.client_id, inst.client_secret, 'http://localhost');
o.setCredentials(token);
const gmail = google.gmail({ version: 'v1', auth: o });

// Newest send to this recipient = the one that is correct.
const l = await gmail.users.messages.list({
  userId: 'me', q: `in:sent to:${to} subject:"${subjectFragment}"`, maxResults: 5
});
const ids = l.data.messages || [];
if (!ids.length) { console.log('NO SEND FOUND for', to); process.exit(1); }
const newest = ids[0];
const d = await gmail.users.messages.get({ userId: 'me', id: newest.id, format: 'raw' });
const raw = Buffer.from(d.data.raw, 'base64').toString('utf8');

// ── Subject, decoded the way the recipient's client sees it ────────────────
const line = (raw.match(/^Subject: (.*)$/m) || [])[1] || '';
const enc = line.match(/=\?UTF-8\?B\?([^?]+)\?=/);
const subject = enc ? Buffer.from(enc[1], 'base64').toString('utf8') : line;
console.log('gmail id  :', newest.id);
console.log('subject   :', subject);
console.log('subject ok:', !/Ã|â€/.test(subject) && subject.length > 0 ? 'clean' : 'MOJIBAKE');

const m = raw.match(/<html[\s\S]*<\/html>/i);
if (!m) { console.log('NO HTML FOUND'); process.exit(1); }
const html = m[0];

// Normalise whitespace before prose checks. The raw HTML wraps sentences across
// source lines, so a check like /Ontario residents only/ misses a phrase that
// renders perfectly ("Ontario\n        residents only").
const flat = html.replace(/<[^>]+>/g, ' ').replace(/&mdash;/g, '\u2014').replace(/\s+/g, ' ');

const checks = {
  'logo img present'       : /<img[^>]+logo-email\.png/.test(html),
  'gradient CTA button'    : /linear-gradient\(135deg,#f97316/.test(html),
  'site link present'      : /https:\/\/mototrackiq\.com/.test(html),
  'Beta nav instruction'   : /Beta/.test(html),
  'waitlist CTA'           : /Join the Waitlist/i.test(flat),
  'confirm-email step'     : /confirmation email/i.test(flat),
  'Ontario limit stated'   : /Ontario residents only/i.test(flat),
  'reply route present'    : /info@mototrackiq\.com/.test(html),
  'no temp-password copy'  : !/temporary password|temp password/i.test(flat),
  'no false access claim'  : !/access is ready|your access is set up|your account is ready/i.test(flat),
  'no credit-count claim'  : !/\b\d+\s*report credits?\b/i.test(flat),
  'no set-password link'   : !/set your password|create your password/i.test(flat),
  'no unescaped entity'    : !/&(mdash|nbsp|amp);/.test(html)
};
console.log('\n=== STRUCTURE CHECKS ===');
let bad = 0;
for (const [k, v] of Object.entries(checks)) {
  if (!v) bad++;
  console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
}

// ── Render exactly as a mail client would ──────────────────────────────────
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
await page.setViewport({ width: 620, height: 900 });
const perr = [];
page.on('pageerror', e => perr.push(e.message));
await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise(r => setTimeout(r, 1200));

const logoOk = await page.evaluate(() => {
  const i = document.querySelector('img');
  // naturalWidth (not nativeWidth) — a typo here silently reports a working
  // logo as broken.
  return !!i && i.complete && i.naturalWidth > 0;
});
const bodyText = await page.evaluate(() => document.body.innerText);

console.log('\n=== RENDER ===');
console.log('  logo loads remotely :', logoOk ? 'PASS' : 'FAIL (broken image)');
console.log('  JS errors           :', perr.length === 0 ? 'none' : perr.join(' | '));
console.log('  rendered chars      :', bodyText.length);

const shot = `/tmp/beta-invite-${to.replace(/[^a-z0-9]/gi, '_')}.png`;
await page.screenshot({ path: shot, fullPage: true });
console.log('  screenshot          :', shot);

console.log('\n=== RENDERED TEXT ===');
console.log(bodyText.replace(/\n{3,}/g, '\n\n'));

if (bad || !logoOk || perr.length) { console.log('\nRESULT: FAIL'); process.exit(1); }
console.log('\nRESULT: PASS');
