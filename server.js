
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { cleanExpiredSessions, migrateLegacyBetaSignups, initDb, createSession, getDeviceSessions, getAllSessions, getSessionById } from './lib/db.js';
import { analyzeCSV } from './lib/analyzer.js';
import { generateReport } from './lib/reportGenerator.js';
import { sendReportEmail } from './lib/email.js';
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
import jwt from 'jsonwebtoken';
import authRoutes from './routes/auth.js';
import sessionsRoutes from './routes/sessions.js';
import ingestRoutes from './routes/ingest.js';
import { signupHandler, confirmHandler, countHandler } from './routes/beta.js';
import adminRoutes from './routes/admin.js';
import deviceReportsRoutes from './routes/device-reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3009', 10);

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();
app.use(cors({ origin: true, credentials: true }));
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

// Beta routes at correct paths
// Public CSV analysis (no auth required — for guest upload flow)
app.post('/api/analyze', upload.single('file'), (req, res) => {
  try {
    const csv = req.file ? req.file.buffer.toString('utf-8') : req.body.csv;
    if (!csv) return res.status(400).json({ error: 'No CSV provided' });
    const data = analyzeCSV(csv);
    return res.json({ success: true, data });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Upload CSV → generate PDF report → email it (public guest flow) ────────
app.post('/api/report/email', upload.single('file'), async (req, res) => {
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
    if (!analysis || !analysis.laps || analysis.laps.length === 0) {
      return res.status(422).json({ error: 'No valid laps found in this CSV. Check the file and try again.' });
    }

    const pdfBuffer = await generateReport(analysis, { riderName: riderName || 'Rider', bikeName });
    const sendResult = await sendReportEmail(email, riderName, pdfBuffer, analysis, {
      specials: req.body.specials !== 'false'
    });
    if (!sendResult.success) {
      return res.status(502).json({ error: 'Report generated but email failed', detail: sendResult.error });
    }

    return res.json({
      success: true,
      message: `Report sent to ${email}`,
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
const JWT_SECRET = process.env.JWT_SECRET || '<REDACTED-JWT-LITERAL>';
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
