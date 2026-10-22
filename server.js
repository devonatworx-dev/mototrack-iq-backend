
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { cleanExpiredSessions, migrateLegacyBetaSignups, initDb, createSession, getDeviceSessions, getAllSessions, getSessionById, getEntitlement, consumeReportCredit, addReportCredits } from './lib/db.js';
import { analyzeCSV } from './lib/analyzer.js';
import { generateReport } from './lib/reportGenerator.js';
import { sendReportEmail } from './lib/email.js';
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
import jwt from 'jsonwebtoken';
import authRoutes from './routes/auth.js';
import sessionsRoutes from './routes/sessions.js';
import ingestRoutes from './routes/ingest.js';
import { signupHandler, confirmHandler, countHandler, resendHandler } from './routes/beta.js';
import adminRoutes from './routes/admin.js';
import deviceReportsRoutes from './routes/device-reports.js';
import promoRoutes from './routes/promo.js';
import feedbackRoutes from './routes/feedback.js';
import checkoutRoutes from './routes/checkout.js';
import { requireAuth } from './lib/middleware/auth.js';
import config from './lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3009', 10);

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();
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
app.use('/api/sessions/ingest', ingestRoutes);  // ESP32 bridge (no auth)
app.use('/api/sessions', sessionsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/device', deviceReportsRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api', checkoutRoutes);  // /api/checkout/:product (JSON body, auth)

// Beta routes at correct paths
// P0 (2026-07-06): these were open anonymous free-analysis routes (unlimited free
// full analysis + PDF, no account). The live frontend uses the authed /api/sessions
// flow and does NOT call these, so gating them behind requireAuth closes a free-tier
// leak with no user-facing impact. Revisit once the credit/entitlement system (P1)
// lands — the free report should decrement a credit, not be wide open.
// UPLOAD IS THE PAYWALL (P2 redesign): analyzing/uploading a session is what
// consumes a token. When the rider is out of tokens we block here with a 402
// so they never do the work, and the frontend shows the "out of tokens" CTA.
// (PDF download is now FREE — the token was already spent at upload.)
app.post('/api/analyze', requireAuth, upload.single('file'), (req, res) => {
  try {
    const csv = req.file ? req.file.buffer.toString('utf-8') : req.body.csv;
    if (!csv) return res.status(400).json({ error: 'No CSV provided' });

    const ent = getEntitlement(req.riderId);
    if (ent && !ent.canGenerate) {
      return res.status(402).json({
        error: 'Out of tokens',
        paywall: true,
        reportCredits: ent.reportCredits,
        plan: ent.plan,
        message: 'Out of tokens \u2014 please purchase from the Membership page or redeem a promo code from the menu.'
      });
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

    // CREDIT GATE (P1): the direct analyze->report path must honor the same
    // paywall as /api/sessions/:id/report, otherwise it's a free-report bypass.
    const ent = getEntitlement(req.riderId);
    if (ent && !ent.canGenerate) {
      return res.status(402).json({
        error: 'Out of tokens',
        paywall: true,
        reportCredits: ent.reportCredits,
        plan: ent.plan,
        message: 'Out of tokens \u2014 please purchase from the Membership page or redeem a promo code from the menu.'
      });
    }

    const analysis = analyzeCSV(csv);
    if (!analysis || !analysis.laps || analysis.laps.length === 0) {
      return res.status(422).json({ error: 'No valid laps found in this CSV.' });
    }
    const riderName = (req.body.riderName || req.body.name || 'Rider').trim();
    const bikeName = (req.body.bike || '').trim();
    const pdf = await generateReport(analysis, { riderName, bikeName });

    // Consume AFTER successful generation so a failure never burns a credit.
    const after = consumeReportCredit(req.riderId);
    if (!after) {
      return res.status(402).json({ error: 'Out of tokens', paywall: true, message: 'Out of tokens \u2014 please purchase from the Membership page or redeem a promo code from the menu.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="MotoTrackIQ-Report.pdf"');
    res.setHeader('X-Report-Credits-Remaining', String(after.reportCredits));
    res.setHeader('X-Reports-Generated', String(after.reportsGenerated));
    res.setHeader('X-Ask-Review', after.reportsGenerated === 1 ? '1' : '0');
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

    // CREDIT GATE (P1): emailing a report is the same paid action as downloading
    // one — gate it identically so it can't be used to bypass the paywall.
    const ent = getEntitlement(req.riderId);
    if (ent && !ent.canGenerate) {
      return res.status(402).json({
        error: 'Out of tokens',
        paywall: true,
        reportCredits: ent.reportCredits,
        plan: ent.plan,
        message: 'Out of tokens \u2014 please purchase from the Membership page or redeem a promo code from the menu.'
      });
    }

    const analysis = analyzeCSV(csv);
    if (!analysis || !analysis.laps || analysis.laps.length === 0) {
      return res.status(422).json({ error: 'No valid laps found in this CSV. Check the file and try again.' });
    }

    const pdfBuffer = await generateReport(analysis, { riderName: riderName || 'Rider', bikeName });

    // Consume AFTER successful generation, BEFORE emailing, so a rider can't
    // repeatedly email themselves reports on a single credit.
    const after = consumeReportCredit(req.riderId);
    if (!after) {
      return res.status(402).json({ error: 'Out of tokens', paywall: true, message: 'Out of tokens \u2014 please purchase from the Membership page or redeem a promo code from the menu.' });
    }
    const sendResult = await sendReportEmail(email, riderName, pdfBuffer, analysis, {
      specials: req.body.specials !== 'false'
    });
    if (!sendResult.success) {
      // Email failed after we consumed the credit — refund it so the rider
      // isn't charged for a report they never received.
      try { addReportCredits(req.riderId, 1); } catch (_) {}
      return res.status(502).json({ error: 'Report generated but email failed', detail: sendResult.error });
    }

    return res.json({
      success: true,
      message: `Report sent to ${email}`,
      reportCredits: after.reportCredits,
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

// ── Device upload (BLE Sync → DB, optional auth to link to rider account) ───
// Required secret, no public fallback (see lib/config.js for why).
const JWT_SECRET = config.jwtSecret;
app.post('/api/device/upload', upload.single('file'), (req, res) => {
  try {
    const csv = req.file ? req.file.buffer.toString('utf-8') : req.body.csv;
    if (!csv) return res.status(400).json({ error: 'No CSV provided' });

    const deviceName = req.body.deviceName || req.body.device || `Device-${Date.now()}`;
    const riderName  = req.body.riderName  || req.body.rider  || 'Unknown Rider';
    const slotId     = req.body.slotId     || req.body.slot   || null;
    const bike       = req.body.bike       || null;
    const track      = req.body.track      || null;

    // Optional: link to rider account if a valid token is provided
    let riderId = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
        riderId = decoded.riderId || null;
      } catch (_) { /* invalid token — upload anonymously */ }
    }

    const analysis = analyzeCSV(csv);
    const id = crypto.randomUUID();
    const date = new Date().toISOString().split('T')[0];
    const name = `${riderName} — ${deviceName} — ${date}`;

    const session = createSession({
      id,
      riderId,
      deviceName,
      riderName,
      slotId,
      name,
      track: track || analysis?.summary?.trackName || null,
      bike,
      date,
      csvContent: csv,
      analysisData: analysis,
    });

    return res.json({ success: true, sessionId: id, session: { id, name, deviceName, riderName, slotId, date }, analysis });
  } catch (err) {
    console.error('[device/upload]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── Device dashboard API (no auth) ───────────────────────────────────────────
app.get('/api/device/sessions', (req, res) => {
  try {
    const { date } = req.query;
    const sessions = getDeviceSessions({ date });
    res.json({ sessions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/device/sessions/today', (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const sessions = getDeviceSessions({ date: today });
    res.json({ date: today, sessions, count: sessions.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/device/sessions/:id', (req, res) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    res.json({ session });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// End of day review — all sessions for a date
app.get('/api/device/eod', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const sessions = getAllSessions({ date });
    const summary = {
      date,
      totalSessions: sessions.length,
      devices: [...new Set(sessions.map(s => s.deviceName).filter(Boolean))],
      riders: [...new Set(sessions.map(s => s.riderName).filter(Boolean))],
      sessions: sessions.map(s => ({
        id: s.id,
        name: s.name,
        deviceName: s.deviceName,
        riderName: s.riderName,
        slotId: s.slotId,
        track: s.track,
        bike: s.bike,
        lapCount: s.analysisData?.laps?.length || s.analysisData?.lapCount || 0,
        bestLap: s.analysisData?.summary?.bestLap || s.analysisData?.bestLap || null,
        createdAt: s.createdAt,
      }))
    };
    res.json(summary);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/beta-signup', signupHandler);
app.post('/api/beta/confirm', confirmHandler);
app.post('/api/beta/resend', resendHandler);
app.get('/api/beta/count', countHandler);

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
  await initDb();
  console.log('Database initialized');

  try {
    const result = await migrateLegacyBetaSignups(path.join(__dirname, '..', 'mototrack-iq-backend', 'data', 'beta-signups.json'));
    if (result && result.migrated > 0) console.log(`Migrated ${result.migrated} legacy beta signups`);
  } catch (e) { /* skip */ }

  cleanExpiredSessions();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server ready on port ${PORT}`);
  });
}

start();
