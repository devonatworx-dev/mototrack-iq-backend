import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getSessionsByRider, getSessionById, createSessionData, getEntitlement, consumeReportCredit } from '../lib/db.js';
import { analyzeCSV } from '../lib/analyzer.js';
import { generateReport } from '../lib/reportGenerator.js';
import { buildDayProgress, generateDayReport } from '../lib/dayReport.js';
import { requireAuth } from '../lib/middleware/auth.js';
import { signReportUrl } from '../lib/reportLink.js';

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

// NOTE: static-path GET routes (/entitlement, /progress) are declared BEFORE the
// '/:id' param route so Express doesn't treat 'entitlement'/'progress' as an id.

// Lightweight entitlement check for the frontend (credits, plan, canGenerate).
router.get('/entitlement', requireAuth, (req, res) => {
  try {
    const ent = getEntitlement(req.riderId);
    if (!ent) return res.status(404).json({ error: 'Rider not found' });
    res.json({ entitlement: ent });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// GET /api/sessions/progress?date=YYYY-MM-DD  — day-level grouped data (static path,
// declared before '/:id' so 'progress' isn't matched as a session id).
router.get('/progress', requireAuth, (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
    const all = getSessionsByRider(req.riderId);
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

router.get('/:id', requireAuth, (req, res) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.riderId !== req.riderId) return res.status(403).json({ error: 'Forbidden' });
    res.json({ session });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// Full PDF report — CREDIT-GATED (P1). Each generation consumes one report credit
// unless the rider is on an unlimited plan (season/pro). When out of credits we
// return 402 with a paywall payload so the frontend can show the upgrade CTA.
// The credit is consumed only AFTER the PDF is successfully generated, so a
// generation failure never burns a rider's credit.
router.post('/:id/report', requireAuth, async (req, res) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.riderId !== req.riderId) return res.status(403).json({ error: 'Forbidden' });

    if (!session.analysisData || typeof session.analysisData !== 'object' || !session.analysisData.summary) {
      return res.status(400).json({ error: 'No analysis data for this session yet. Please upload a CSV file first.' });
    }

    const ent = getEntitlement(req.riderId);
    if (ent && !ent.canGenerate) {
      return res.status(402).json({
        error: 'No report credits remaining',
        paywall: true,
        reportCredits: ent.reportCredits,
        plan: ent.plan,
        message: "You've used your free analysis. Subscribe or enter a promo code to unlock more reports."
      });
    }

    const { riderName, bikeName } = req.body;
    const pdf = await generateReport(session.analysisData, { riderName: riderName||'Rider', bikeName: bikeName||session.bike||'' });

    // Consume AFTER successful generation. If this returns null it means credits
    // were exhausted between the check and now (race) — treat as paywall.
    const after = consumeReportCredit(req.riderId);
    if (!after) {
      return res.status(402).json({ error: 'No report credits remaining', paywall: true });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="mototrackiq-report-${session.id}.pdf"`);
    // Surface remaining credits + the review-ask trigger to the client.
    res.setHeader('X-Report-Credits-Remaining', String(after.reportCredits));
    res.setHeader('X-Reports-Generated', String(after.reportsGenerated));
    res.setHeader('X-Ask-Review', after.reportsGenerated === 1 ? '1' : '0');
    res.send(pdf);
  } catch (err) { console.error('REPORT ERROR:', err.message); console.error(err.stack); res.status(500).json({ error: 'Report failed: ' + err.message }); }
});

// Rider requests a short-lived signed link to (re)download an already-generated
// report PDF. FREE — no credit is consumed (the credit was spent at generation).
// Requires login + ownership; the returned URL works for browser navigation.
router.get('/:id/report-link', requireAuth, (req, res) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.riderId !== req.riderId) return res.status(403).json({ error: 'Forbidden' });
    if (!session.analysisData || typeof session.analysisData !== 'object' || !session.analysisData.summary) {
      return res.status(400).json({ error: 'No report available for this session yet.' });
    }
    res.json({ url: signReportUrl(session.id) });
  } catch (err) { console.error('[report-link]', err.message); res.status(500).json({ error: 'Failed' }); }
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
