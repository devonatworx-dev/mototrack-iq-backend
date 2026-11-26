
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { cleanExpiredSessions, migrateLegacyBetaSignups, initDb, getEntitlement, planSessionCharge, consumeSessionCredit, refundSessionCredit, getDbFilePath } from './lib/db.js';
import { denialPayload, normalizeSessionDay } from './lib/pricing.js';
import { createBackup, startDailyBackups, resolveBackupDir, backupRetention } from './lib/backup.js';
import { analyzeCSV } from './lib/analyzer.js';
import { generateReport } from './lib/reportGenerator.js';
import { sendReportEmail } from './lib/email.js';
import { warnIfMailingAddressMissing } from './lib/casl.js';
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
import authRoutes from './routes/auth.js';
import sessionsRoutes from './routes/sessions.js';
import adminRoutes from './routes/admin.js';
import deviceReportsRoutes from './routes/device-reports.js';
import promoRoutes from './routes/promo.js';
import feedbackRoutes from './routes/feedback.js';
import checkoutRoutes from './routes/checkout.js';
import emailRoutes from './routes/email.js';
import { requireAuth } from './lib/middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3009', 10);

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();
// Railway terminates TLS and forwards X-Forwarded-Proto. OAuth redirect_uri
// must be https in production or the provider rejects it. Hop count is not
// stable, so req.ip is often the edge address. Auth rate limits key on
// X-Real-IP instead (see lib/rate-limit.js). trust proxy stays at 1 so
// req.protocol follows X-Forwarded-Proto without trusting every hop.
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));

// LemonSqueezy webhook needs the RAW body for HMAC signature verification, so it
// MUST be mounted with express.raw() BEFORE the global express.json() parser.
app.use('/api/webhooks/lemonsqueezy', express.raw({ type: '*/*', limit: '2mb' }), checkoutRoutes);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) app.use(express.static(publicPath));

app.get('/health', (req, res) => res.json({ status: 'ok', v: '2.0.0' }));

app.use('/api/auth', authRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/device', deviceReportsRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api', checkoutRoutes);  // /api/checkout/:product (JSON body, auth)

function oneShotDay(req, analysis) {
  return normalizeSessionDay(req.body?.date) || normalizeSessionDay(analysis?.summary?.sessionDate);
}

// These routes used to be anonymous. They require a rider JWT.
// /api/analyze is a preview gate only: it refuses a rider who cannot pay for
// a session, and it does not spend a credit. POST /api/sessions spends exactly
// one credit for that session. Generating or re-downloading its PDF is free.
// /api/report and /api/report/email are one-shot PDFs with no saved session,
// so each successful one spends one credit here (not a second charge on top
// of analyze).
app.post('/api/analyze', requireAuth, upload.single('file'), (req, res) => {
  try {
    const csv = req.file ? req.file.buffer.toString('utf-8') : req.body.csv;
    if (!csv) return res.status(400).json({ error: 'No CSV provided' });

    const ent = getEntitlement(req.riderId);
    if (ent && !ent.canGenerate) {
      return res.status(402).json(denialPayload('out_of_credits', ent));
    }

    const data = analyzeCSV(csv);
    return res.json({ success: true, data });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Upload CSV → download PDF report directly (now auth-gated; see P0 note above) ──
app.post('/api/report', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const csv = req.file ? req.file.buffer.toString('utf-8') : req.body.csv;
    if (!csv) return res.status(400).json({ error: 'No CSV provided' });

    const analysis = analyzeCSV(csv);
    const day = oneShotDay(req, analysis);
    // One-shot PDF with no saved session: this call is the charge.
    const preview = planSessionCharge(req.riderId, day);
    if (!preview.ok) return res.status(402).json(denialPayload(preview.code, preview.entitlement, preview));
    if (!analysis || !analysis.laps || analysis.laps.length === 0) {
      return res.status(422).json({ error: 'No valid laps found in this CSV.' });
    }
    const riderName = (req.body.riderName || req.body.name || 'Rider').trim();
    const bikeName = (req.body.bike || '').trim();
    const pdf = await generateReport(analysis, { riderName, bikeName });

    // Spend after the PDF exists so a failed render does not burn a credit.
    const after = consumeSessionCredit(req.riderId, { sessionDate: day });
    if (!after.ok) return res.status(402).json(denialPayload(after.code, after.entitlement, after));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="MotoTrackIQ-Report.pdf"');
    res.setHeader('X-Report-Credits-Remaining', String(after.entitlement.reportCredits));
    res.setHeader('X-Reports-Generated', String(after.entitlement.reportsGenerated));
    res.setHeader('X-Ask-Review', after.entitlement.reportsGenerated === 1 ? '1' : '0');
    return res.send(pdf);
  } catch (err) { console.error('[report]', err); return res.status(500).json({ error: err.message }); }
});

// ── Upload CSV → generate PDF report → email it (now auth-gated; see P0 note above) ──
app.post('/api/report/email', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const csv = req.file ? req.file.buffer.toString('utf-8') : req.body.csv;
    const email = (req.body.email || '').trim();
    if (!csv) return res.status(400).json({ error: 'No CSV provided' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    const riderName = (req.body.riderName || req.body.name || '').trim();
    const bikeName  = (req.body.bike || '').trim();

    const analysis = analyzeCSV(csv);
    const day = oneShotDay(req, analysis);
    // Same one-shot charge as /api/report. Analyze does not spend a credit.
    const preview = planSessionCharge(req.riderId, day);
    if (!preview.ok) return res.status(402).json(denialPayload(preview.code, preview.entitlement, preview));
    if (!analysis || !analysis.laps || analysis.laps.length === 0) {
      return res.status(422).json({ error: 'No valid laps found in this CSV. Check the file and try again.' });
    }

    const pdfBuffer = await generateReport(analysis, { riderName: riderName || 'Rider', bikeName });

    // Spend before the send so a delivered email cannot be repeated for free.
    // Refund the same balance if the email is not actually sent.
    const charge = consumeSessionCredit(req.riderId, { sessionDate: day });
    if (!charge.ok) return res.status(402).json(denialPayload(charge.code, charge.entitlement, charge));
    const sendResult = await sendReportEmail(email, riderName, pdfBuffer, analysis, {
      specials: req.body.specials !== 'false'
    });
    if (!sendResult.success) {
      try { refundSessionCredit(req.riderId, charge); } catch (_) {}
      return res.status(502).json({ error: 'Report generated but email failed', detail: sendResult.error });
    }

    return res.json({
      success: true,
      message: `Report sent to ${email}`,
      reportCredits: charge.entitlement.reportCredits,
      summary: {
        track: analysis.summary?.trackName,
        bestLap: analysis.lapStats?.best,
        laps: analysis.lapStats?.count
      }
    });
  } catch (err) {
    console.error('[report/email]', err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/health')) {
    const idx = path.join(publicPath, 'index.html');
    if (fs.existsSync(idx)) return res.sendFile(idx);
    res.status(404).json({ error: 'Not found' });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

async function start() {
  warnIfMailingAddressMissing();
  await initDb();
  console.log(`Database initialized (${getDbFilePath()})`);
  console.log(`Database backups: ${resolveBackupDir()} (keep ${backupRetention()})`);

  try {
    const result = await migrateLegacyBetaSignups(path.join(__dirname, '..', 'mototrack-iq-backend', 'data', 'beta-signups.json'));
    if (result && result.migrated > 0) console.log(`Migrated ${result.migrated} legacy beta signups`);
  } catch (e) { /* skip */ }

  cleanExpiredSessions();

  // Best-effort copy of the live database. A failed backup must not stop
  // the process, and this path never copies a backup back over DB_PATH.
  createBackup().catch(() => {});
  startDailyBackups();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server ready on port ${PORT}`);
  });
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) start();

export { app };
