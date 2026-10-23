#!/usr/bin/env node
/**
 * research-digest.mjs
 * Convert the latest GTA business acquisition research markdown into a styled PDF
 * and email it to the research mailing list via the existing Gmail OAuth setup.
 *
 * Reuses:
 *   - google-chrome (via puppeteer-core) for markdown->HTML->PDF
 *   - MotoTrackIQ v2 Gmail OAuth (config/credentials.json + config/token.json)
 *   - marked (markdown parser) from the v2 project node_modules
 *
 * Usage:
 *   node scripts/research-digest.mjs                # BUNDLE latest N nights (default 7) into one PDF
 *   node scripts/research-digest.mjs <file.md>      # single specific file
 *   BUNDLE_DAYS=7 node scripts/research-digest.mjs  # how many recent nights to bundle
 *   DRY_RUN=1 node scripts/research-digest.mjs      # build PDF, skip send
 *   TEST_TO=you@x.com node scripts/research-digest.mjs  # override recipients (send only to this)
 *
 * Config:
 *   config/research-mailing-list.json  -> { "recipients": ["a@x.com", "b@y.com"] }
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { marked } from 'marked';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This script lives in mototrack-iq-backend-v2/scripts so its imports resolve
// against v2's node_modules. Everything else reads/writes the workspace root.
const V2 = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(V2, '..');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const CONFIG_DIR = path.join(WORKSPACE, 'config');
const OUT_DIR = path.join(WORKSPACE, 'tmp', 'research-pdfs');

const CREDENTIALS_PATH = path.join(V2, 'config', 'credentials.json');
const TOKEN_PATH = path.join(V2, 'config', 'token.json');
const MAILING_LIST_PATH = path.join(CONFIG_DIR, 'research-mailing-list.json');

// The OAuth-authenticated account that performs the send.
const GMAIL_USER = process.env.GMAIL_USER || 'devonatworx@gmail.com';
// Public-facing From identity. info@mototrackiq.com is a verified "Send mail as"
// alias on GMAIL_USER, so mail sends AS info@ (passes SPF/DKIM/DMARC for the domain).
const FROM_EMAIL = process.env.FROM_EMAIL || 'info@mototrackiq.com';
const FROM_NAME = process.env.FROM_NAME || 'MotoTrackIQ — GTA Acquisition Intel';
const REPLY_TO = process.env.REPLY_TO || 'info@mototrackiq.com';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';

// ── Locate research markdown files ───────────────────────────────────────────
function allResearchFiles() {
  return readdirSync(MEMORY_DIR)
    .filter(f => /^gta-biz-research-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .map(f => path.join(MEMORY_DIR, f));
}
function latestResearchFile() {
  const files = allResearchFiles();
  if (!files.length) throw new Error('No gta-biz-research-*.md files found in memory/');
  return files[files.length - 1];
}
// Most-recent N files (default 7), oldest→newest so the bundle reads chronologically.
function recentResearchFiles(n) {
  const files = allResearchFiles();
  if (!files.length) throw new Error('No gta-biz-research-*.md files found in memory/');
  return files.slice(Math.max(0, files.length - n));
}

// ── Recipients ───────────────────────────────────────────────────────────────
function getRecipients() {
  if (process.env.TEST_TO) return process.env.TEST_TO.split(',').map(s => s.trim()).filter(Boolean);
  if (!existsSync(MAILING_LIST_PATH)) {
    throw new Error(`Mailing list not found: ${MAILING_LIST_PATH}`);
  }
  const list = JSON.parse(readFileSync(MAILING_LIST_PATH, 'utf8'));
  const recipients = (list.recipients || []).map(s => String(s).trim()).filter(Boolean);
  if (!recipients.length) throw new Error('Mailing list is empty');
  return recipients;
}

// ── Extract title/sector/date from the markdown front matter lines ────────────
function parseMeta(md, fallbackName) {
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const sectorMatch = md.match(/^\*\*Sector:\*\*\s*(.+)$/m);
  const dateMatch = fallbackName.match(/(\d{4}-\d{2}-\d{2})/);
  const ratingMatch = md.match(/Success Rating:\s*\*\*([\d.]+\s*\/\s*10)\*\*/i);
  return {
    title: titleMatch ? titleMatch[1].trim() : 'GTA Business Acquisition Research',
    sector: sectorMatch ? sectorMatch[1].replace(/\(.*?\)/, '').trim() : '',
    date: dateMatch ? dateMatch[1] : '',
    rating: ratingMatch ? ratingMatch[1].replace(/\s+/g, '') : '',
  };
}

// ── Build styled HTML from one or more markdown docs ─────────────────────────
// sections: [{ md, meta }]. Multiple sections get a cover + page breaks.
function buildHtmlBundle(sections) {
  marked.setOptions({ gfm: true, breaks: false });
  const multi = sections.length > 1;
  let inner = '';
  if (multi) {
    const rows = sections.map(s =>
      `<tr><td style="padding:6px 9px;">${s.meta.date || ''}</td>` +
      `<td style="padding:6px 9px;">${s.meta.sector || s.meta.title}</td>` +
      `<td style="padding:6px 9px;font-weight:700;color:#ea580c;">${s.meta.rating || '—'}</td></tr>`).join('');
    inner += `<div class="cover">` +
      `<div style="color:#f97316;font-size:11pt;font-weight:700;letter-spacing:2px;">GTA BUSINESS ACQUISITION INTELLIGENCE</div>` +
      `<h1 style="border:none;font-size:26pt;margin:10px 0 4px;">Research Digest</h1>` +
      `<div style="color:#555;font-size:12pt;margin-bottom:24px;">${sections.length} sector reports · compiled by Devon for Everett</div>` +
      `<table><tr><th>Date</th><th>Sector</th><th>Rating</th></tr>${rows}</table>` +
      `</div>`;
  }
  inner += sections.map((s, i) => {
    const body = marked.parse(s.md);
    const brk = (multi && i > 0) ? ' style="page-break-before:always;"' : (multi ? ' style="page-break-before:always;"' : '');
    return `<section${brk}>${body}</section>`;
  }).join('\n');
  return htmlShell(inner);
}

function htmlShell(bodyInner) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  @page { size: A4; margin: 20mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; font-size: 11pt; line-height: 1.55; margin: 0; }
  h1 { font-size: 20pt; color: #0d0d0d; border-bottom: 3px solid #f97316; padding-bottom: 8px; margin: 0 0 6px; }
  h2 { font-size: 14pt; color: #0d0d0d; margin: 22px 0 8px; padding-left: 10px; border-left: 4px solid #f97316; }
  h3 { font-size: 12pt; color: #ea580c; margin: 16px 0 6px; }
  p { margin: 6px 0; }
  a { color: #0369a1; text-decoration: none; }
  strong { color: #0d0d0d; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 9.5pt; page-break-inside: avoid; }
  th { background: #0d0d0d; color: #fff; text-align: left; padding: 7px 9px; font-weight: 600; }
  td { border: 1px solid #e2e2e2; padding: 6px 9px; vertical-align: top; }
  tr:nth-child(even) td { background: #f7f7f7; }
  ul, ol { margin: 6px 0 6px 4px; padding-left: 20px; }
  li { margin: 3px 0; }
  blockquote { border-left: 4px solid #38bdf8; background: #f0f9ff; margin: 12px 0; padding: 8px 14px; color: #075985; }
  code { background: #f1f1f1; padding: 1px 5px; border-radius: 3px; font-size: 9.5pt; }
  hr { border: none; border-top: 1px solid #e2e2e2; margin: 18px 0; }
  em { color: #555; }
</style></head>
<style>
  .cover { text-align:center; padding-top:60px; page-break-after:always; }
  .cover table { max-width:80%; margin:0 auto; text-align:left; }
  section { }
</style>
<body>${bodyInner}</body></html>`;
}

// ── Markdown -> PDF via headless Chrome ───────────────────────────────────────
async function renderPdf(html) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#999;padding:0 14mm;display:flex;justify-content:space-between;">' +
        '<span>Devon · GTA Business Acquisition Intelligence</span>' +
        '<span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ── Gmail client (mirrors v2 lib/email.js) ───────────────────────────────────
async function getGmailClient() {
  let client_id = process.env.GOOGLE_CLIENT_ID;
  let client_secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
    const inst = credentials.installed || credentials.web || credentials;
    client_id = client_id || inst.client_id;
    client_secret = client_secret || inst.client_secret;
  }
  let token;
  if (process.env.GOOGLE_REFRESH_TOKEN) token = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
  else token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost');
  oauth2Client.setCredentials(token);
  const { credentials: fresh } = await oauth2Client.refreshAccessToken();
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    try { writeFileSync(TOKEN_PATH, JSON.stringify({ ...token, ...fresh }, null, 2)); } catch {}
  }
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function encodeHeader(str) {
  const s = String(str);
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Email body (light, simple — the PDF is the main artifact)
function emailHtml(meta, bundleCount) {
  const bundleLine = bundleCount
    ? `<tr><td style="padding:8px 12px;color:#6b7280;width:130px;">Reports bundled</td><td style="padding:8px 12px;font-weight:700;color:#111;">${bundleCount} sectors</td></tr>` : '';
  const ratingLine = meta.rating
    ? `<tr><td style="padding:8px 12px;color:#6b7280;">Success rating</td><td style="padding:8px 12px;font-weight:700;color:#ea580c;">${esc(meta.rating)}</td></tr>` : '';
  const sectorLine = meta.sector
    ? `<tr><td style="padding:8px 12px;color:#6b7280;">Sector</td><td style="padding:8px 12px;font-weight:600;color:#111;">${esc(meta.sector)}</td></tr>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px;">
    <div style="background:#0d0d0d;padding:26px 28px;border-radius:12px 12px 0 0;">
      <div style="color:#f97316;font-size:12px;font-weight:700;letter-spacing:1px;">GTA BUSINESS ACQUISITION INTELLIGENCE</div>
      <h1 style="color:#fff;margin:8px 0 0;font-size:19px;">${esc(meta.title)}</h1>
    </div>
    <div style="background:#fff;padding:26px 28px;border-radius:0 0 12px 12px;border:1px solid #e5e5e5;border-top:none;">
      <p style="color:#374151;line-height:1.7;margin:0 0 16px;">Here's the latest acquisition research digest${bundleCount ? ` — a bundle of ${bundleCount} recent sector reports` : ''}. Full breakdown — market context, valuation multiples, deal structure, risks, and next steps — is attached as a PDF.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fafafa;border:1px solid #eee;border-radius:8px;overflow:hidden;margin-bottom:18px;">
        ${bundleLine}
        ${sectorLine}
        ${meta.date ? `<tr><td style="padding:8px 12px;color:#6b7280;width:130px;">Research date</td><td style="padding:8px 12px;font-weight:600;color:#111;">${esc(meta.date)}</td></tr>` : ''}
        ${ratingLine}
      </table>
      <p style="color:#6b7280;font-size:13px;margin:0;">📎 Full report attached as PDF.</p>
      <p style="color:#9ca3af;font-size:12px;line-height:1.6;margin-top:20px;border-top:1px solid #eee;padding-top:12px;">
        Automated research digest compiled by Devon for Everett. Sources are cited in the attached report. Informational only — not investment or legal advice.
      </p>
    </div>
  </div></body></html>`;
}

function encodeMessageWithAttachment(toList, subject, htmlBody, attachment) {
  const boundary = 'rd_' + Math.random().toString(36).slice(2);
  const { filename, mimeType, content } = attachment;
  const b64 = content.toString('base64').replace(/(.{76})/g, '$1\r\n');
  const msg = [
    `From: "${encodeHeader(FROM_NAME)}" <${FROM_EMAIL}>`,
    `Reply-To: ${REPLY_TO}`,
    `To: ${toList.join(', ')}`,
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
    '',
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argFile = process.argv[2];
  const mdPath = argFile ? path.resolve(argFile) : latestResearchFile();
  if (!existsSync(mdPath)) throw new Error(`File not found: ${mdPath}`);

  // Build the list of source files: single (arg) or bundle (default).
  let files;
  if (argFile) {
    files = [mdPath];
  } else {
    const days = parseInt(process.env.BUNDLE_DAYS || '7', 10);
    files = recentResearchFiles(days);
  }

  const sections = files.map(fp => {
    const md = readFileSync(fp, 'utf8');
    const meta = parseMeta(md, path.basename(fp, '.md'));
    return { md, meta, file: fp };
  });

  const bundle = sections.length > 1;
  const latestMeta = sections[sections.length - 1].meta;
  console.log(`[research-digest] ${bundle ? 'BUNDLE of ' + sections.length + ' reports' : 'single report'}`);
  sections.forEach(s => console.log(`  - ${s.meta.date} | ${s.meta.sector || s.meta.title} | ${s.meta.rating || '—'}`));

  const html = buildHtmlBundle(sections);
  const pdf = await renderPdf(html);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const meta = latestMeta;
  const dateSpan = bundle
    ? `${sections[0].meta.date}_to_${sections[sections.length - 1].meta.date}`
    : (meta.date || path.basename(mdPath, '.md'));
  const pdfName = bundle
    ? `GTA-Acquisition-Research-Digest-${dateSpan}.pdf`
    : `GTA-Acquisition-Research-${meta.date || path.basename(mdPath, '.md')}.pdf`;
  const pdfPath = path.join(OUT_DIR, pdfName);
  writeFileSync(pdfPath, pdf);
  console.log(`[research-digest] PDF written: ${pdfPath} (${(pdf.length / 1024).toFixed(0)} KB)`);

  if (process.env.DRY_RUN) {
    console.log('[research-digest] DRY_RUN set — skipping email send.');
    console.log(`[research-digest] recipients would be: ${(process.env.TEST_TO || 'mailing list').toString()}`);
    return;
  }

  const recipients = getRecipients();
  const subject = bundle
    ? `GTA Acquisition Research Digest — ${sections.length} sectors (${sections[0].meta.date} → ${sections[sections.length - 1].meta.date})`
    : `GTA Acquisition Research${meta.sector ? ` — ${meta.sector}` : ''}${meta.date ? ` (${meta.date})` : ''}`;
  const gmail = await getGmailClient();
  const raw = encodeMessageWithAttachment(recipients, subject, emailHtml(meta, bundle ? sections.length : 0), {
    filename: pdfName, mimeType: 'application/pdf', content: pdf,
  });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  console.log(`[research-digest] ✅ sent to: ${recipients.join(', ')}`);
}

main().catch(err => { console.error('[research-digest] ERROR:', err.message); process.exit(1); });
