import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getSessionsByRider, getSessionById, createSessionData } from '../lib/db.js';
import { analyzeCSV } from '../lib/analyzer.js';
import { generateReport } from '../lib/reportGenerator.js';
import { buildDayProgress, generateDayReport } from '../lib/dayReport.js';
import { requireAuth } from '../lib/middleware/auth.js';

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  try {
    const sessions = getSessionsByRider(req.riderId);
    res.json({ sessions: sessions.map(s => { const { csvContent, ...x } = s; return x; }) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

router.post('/', requireAuth, (req, res) => {
  try {
    const { name, track, bike, date, csvContent: rawCsv } = req.body;
    if (!rawCsv) return res.status(400).json({ error: 'csvContent required' });
    let analysis;
    try { analysis = analyzeCSV(rawCsv); }
    catch (e) { return res.status(400).json({ error: `CSV error: ${e.message}` }); }
    const session = createSessionData({ id: uuidv4(), riderId: req.riderId, name: name || `Session on ${analysis.summary.trackName}`, track: track || analysis.summary.trackName, bike: bike||null, date: date||null, csvContent: rawCsv, analysisData: analysis });
    const { csvContent, ...safe } = session;
    res.status(201).json({ session: safe, analysis });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

router.get('/:id', requireAuth, (req, res) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.riderId !== req.riderId) return res.status(403).json({ error: 'Forbidden' });
    res.json({ session });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

router.post('/:id/report', requireAuth, async (req, res) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.riderId !== req.riderId) return res.status(403).json({ error: 'Forbidden' });
    const { riderName, bikeName } = req.body;
    const pdf = await generateReport(session.analysisData, { riderName: riderName||'Rider', bikeName: bikeName||session.bike||'' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="mototrackiq-report-${session.id}.pdf"`);
    res.send(pdf);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Report failed' }); }
});

router.post('/:id/report/preview', requireAuth, (req, res) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.riderId !== req.riderId) return res.status(403).json({ error: 'Forbidden' });
    const a = session.analysisData;
    res.json({ preview: { summary: a.summary, metrics: a.metrics, laps: a.laps, lapStats: a.lapStats, idealLap: a.idealLap } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Preview failed' }); }
});

// ── Day Progress ──────────────────────────────────────────────────────────────
// GET /api/sessions/progress?date=YYYY-MM-DD  — returns day-level grouped data
router.get('/progress', requireAuth, (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
    const all = getSessionsByRider(req.riderId);
    // Sessions on this date (match by session.date or analysisData.summary.sessionDate)
    const daySessions = all.filter(s => {
      const sd = s.date || null;
      const csd = s.analysisData?.summary?.sessionDate
        ? new Date(s.analysisData.summary.sessionDate).toISOString().slice(0, 10)
        : null;
      return sd === date || csd === date;
    });
    if (daySessions.length === 0) {
      return res.json({ progress: null, message: `No sessions found for ${date}` });
    }
    const progress = buildDayProgress(daySessions);
    res.json({ progress, sessions: daySessions.map(s => { const { csvContent, ...x } = s; return x; }) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// POST /api/sessions/day-report — generates a Day Progress PDF for a given date
router.post('/day-report', requireAuth, async (req, res) => {
  try {
    const { date, riderName, bikeName } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    const all = getSessionsByRider(req.riderId);
    const daySessions = all.filter(s => {
      const sd = s.date || null;
      const csd = s.analysisData?.summary?.sessionDate
        ? new Date(s.analysisData.summary.sessionDate).toISOString().slice(0, 10)
        : null;
      return sd === date || csd === date;
    });
    if (daySessions.length === 0) return res.status(404).json({ error: 'No sessions found for that date' });
    const dayData = buildDayProgress(daySessions);
    const pdf = await generateDayReport(dayData, {
      riderName: riderName || 'Rider',
      bikeName: bikeName || ''
    });
    const safeDate = date.replace(/[^0-9-]/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="MotoTrackIQ-DayProgress-${safeDate}.pdf"`);
    return res.send(pdf);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Report failed' }); }
});

export default router;
