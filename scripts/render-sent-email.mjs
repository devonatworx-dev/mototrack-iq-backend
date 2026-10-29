import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';
import puppeteer from 'puppeteer-core';

const base = '/home/assistant/.openclaw/workspace/mototrack-iq-backend-v2';
const creds = JSON.parse(readFileSync(base + '/config/credentials.json', 'utf8'));
const inst = creds.installed || creds.web || creds;
const token = JSON.parse(readFileSync(base + '/config/token.json', 'utf8'));
const o = new google.auth.OAuth2(inst.client_id, inst.client_secret, 'http://localhost');
o.setCredentials(token);
const gmail = google.gmail({ version: 'v1', auth: o });

// The NEWEST validation send = the one that is correct.
const l = await gmail.users.messages.list({
  userId: 'me', q: 'in:sent to:eacooke10@gmail.com subject:"sign in and get your first report"', maxResults: 5
});
const ids = l.data.messages || [];
if (!ids.length) { console.log('NO SEND FOUND'); process.exit(1); }
const newest = ids[0];
const d = await gmail.users.messages.get({ userId: 'me', id: newest.id, format: 'raw' });
const raw = Buffer.from(d.data.raw, 'base64').toString('utf8');

const m = raw.match(/<html[\s\S]*<\/html>/i);
if (!m) { console.log('NO HTML FOUND'); process.exit(1); }
const html = m[0];
writeFileSync('/tmp/sent-email.html', html);
console.log('html bytes:', html.length);

// Structural checks on the REAL rendered markup.
const checks = {
  'logo img present'      : /<img[^>]+logo-email\.png/.test(html),
  'gradient CTA button'   : /linear-gradient\(135deg,#f97316/.test(html),
  'login deep link'       : /mototrackiq\.com\/\?login=1/.test(html),
  'password copy correct' : /the password you set when you created your account/.test(html),
  'no temp-password copy' : !/temporary password from our/.test(html),
  'forgot-password offer' : /Forgot password/.test(html),
  'session table'         : /Calabogie/.test(html) && /Shannonville/.test(html),
  'no dead set-pw link'   : !/set your password|create your password/i.test(html),
  'reply-to shown'        : /info@mototrackiq\.com/.test(html),
  'no unescaped entity'   : /&(mdash|nbsp|amp);/.test(html) === false
};
console.log('\n=== STRUCTURE CHECKS ===');
let bad = 0;
for (const [k, v] of Object.entries(checks)) {
  if (!v) bad++;
  console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
}

// Render it exactly as a mail client would.
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

const img = await page.evaluate(() => {
  const i = document.querySelector('img');
  return { complete: i ? i.complete : false, w: i ? i.naturalWidth : 0, src: i ? i.src : null };
});
console.log('\n=== LOGO LOADED (remote) ===');
console.log('  naturalWidth:', img.w, img.w > 0 ? '(PASS - logo renders)' : '(FAIL - broken image)');

await page.screenshot({ path: '/tmp/sent-email-render.png', fullPage: true });
console.log('\n  screenshot: /tmp/sent-email-render.png');
console.log('  page errors:', perr.length ? perr.slice(0, 3) : 'none');
console.log('\nSTRUCTURE FAILURES:', bad);

await browser.close();
