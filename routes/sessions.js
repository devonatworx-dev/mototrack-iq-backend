import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getSessionsByRider, getSessionById, createSessionData, deleteSession, getEntitlement, consumeSessionCredit, planSessionCharge, getRiderById, dayReportAccess } from '../lib/db.js';
import { dayReportTooFewPayload, denialPayload, normalizeSessionDay } from '../lib/pricing.js';
import { backfillTrackMap, hasTrackMap } from '../lib/trackMapBackfill.js';
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
    // Saving the session spends exactly one credit (flexible, event day, or
    // season day). /api/analyze only gates and does not spend. The PDF for
    // this session is free after this charge.
    const sessionDay = normalizeSessionDay(date) || normalizeSessionDay(analysis?.summary?.sessionDate);
    const plan = planSessionCharge(req.riderId, sessionDay);
    if (!plan.ok) {
      return res.status(402).json(denialPayload(plan.code, plan.entitlement, plan));
    }

    // Fall back to the rider's profile bike when the upload doesn't specify one
    // (the portal upload flow currently omits bike). `bikes` may be a comma list;
    // use the first entry as the default machine for this session.
    let bikeVal = bike || null;
    if (!bikeVal) {
      const rider = getRiderById(req.riderId);
      if (rider && rider.bikes) bikeVal = String(rider.bikes).split(',')[0].trim() || null;
    }
    const session = createSessionData({ id: uuidv4(), riderId: req.riderId, name: name || `Session on ${analysis.summary.trackName}`, track: track || analysis.summary.trackName, bike: bikeVal, date: date || sessionDay || null, csvContent: rawCsv, analysisData: analysis });

    // Charge after the row exists so a failed insert cannot spend a credit.
    // consumeSessionCredit marks the session paid. A failed charge deletes it.
    const charge = consumeSessionCredit(req.riderId, { sessionDate: sessionDay, sessionId: session.id });
    if (!charge.ok) {
      try { deleteSession(session.id); } catch (_) {}
      return res.status(402).json(denialPayload(charge.code, charge.entitlement, charge));
    }
    const { csvContent, ...safe } = session;
    const ent = charge.entitlement;
    res.status(201).json({
      session: { ...safe, creditConsumed: 1 },
      analysis,
      reportCredits: ent ? ent.reportCredits : null,
      reportsGenerated: ent ? ent.reportsGenerated : undefined,
      askReview: Boolean(ent && ent.reportsGenerated === 1),
      charged: charge.source,
      chargedDay: charge.sessionDate || null,
      entitlement: ent
    });
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

// PDF for a session that was paid when it was saved. Regenerating it is free.
// A session that was never paid (no creditConsumed flag) is charged once here,
// after the PDF is built, so a failed render does not spend the credit.
router.post('/:id/report', requireAuth, async (req, res) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.riderId !== req.riderId) return res.status(403).json({ error: 'Forbidden' });

    if (!session.analysisData || typeof session.analysisData !== 'object' || !session.analysisData.summary) {
      return res.status(400).json({ error: 'No analysis data for this session yet. Please upload a CSV file first.' });
    }

    const alreadyPaid = Number(session.creditConsumed) === 1;
    const sessionDay = normalizeSessionDay(session.date) || normalizeSessionDay(session.analysisData?.summary?.sessionDate);
    if (!alreadyPaid) {
      const plan = planSessionCharge(req.riderId, sessionDay);
      if (!plan.ok) {
        return res.status(402).json(denialPayload(plan.code, plan.entitlement, plan));
      }
    }

    // Legacy sessions (uploaded before the analyzer emitted trackMap) have no
    // map in their stored analysis, so the PDF renders without the speed-heat
    // racing line. The stored CSV is still present, so regenerate the map once
    // and persist it. Failure is non-fatal: the rider still gets the report.
    if (!hasTrackMap(session.analysisData)) {
      try {
        const bf = backfillTrackMap(session);
        // Use the returned session either way: `fixed` is false only when the
        // DB write failed, and in that case the generated map is still valid
        // for THIS report (it just will not be persisted).
        if (bf.session) session.analysisData = bf.session.analysisData;
      } catch (err) {
        console.error('[sessions] track map backfill failed:', err.message);
      }
    }

    const { riderName, bikeName } = req.body;
    const pdf = await generateReport(session.analysisData, { riderName: riderName||'Rider', bikeName: bikeName||session.bike||'' });

    let ent = getEntitlement(req.riderId);
    let chargedHere = false;
    if (!alreadyPaid) {
      const charge = consumeSessionCredit(req.riderId, { sessionDate: sessionDay, sessionId: session.id });
      if (!charge.ok) {
        return res.status(402).json(denialPayload(charge.code, charge.entitlement, charge));
      }
      ent = charge.entitlement;
      chargedHere = !charge.duplicate;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="mototrackiq-report-${session.id}.pdf"`);
    res.setHeader('X-Report-Credits-Remaining', String(ent ? ent.reportCredits : 0));
    res.setHeader('X-Reports-Generated', String(ent ? ent.reportsGenerated : 0));
    res.setHeader('X-Ask-Review', chargedHere && ent && ent.reportsGenerated === 1 ? '1' : '0');
    res.send(pdf);
  } catch (err) { console.error('REPORT ERROR:', err.message); console.error(err.stack); res.status(500).json({ error: 'Report failed: ' + err.message }); }
});

// Rider requests a short-lived signed link to (re)download a session PDF.
// Free — the credit was spent when the session was saved.
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
// POST /api/sessions/day-report — end-of-day summary for a date with 2 or more
// saved sessions. The PDF orders those sessions and compares each best lap
// with the session before it. Event Pass, Season Pass, and grandfathered
// unlimited plans only.
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
    // Event Pass, Season Pass, and grandfathered unlimited plans include this
    // summary on any date. Flexible credits do not. A pass holder still needs
    // two saved sessions on the date. The portal turns not_included into an upsell.
    const access = dayReportAccess(req.riderId, date, daySessions.length);
    if (!access.ok) {
      if (access.code === 'day_report_needs_multiple_sessions') {
        return res.status(400).json(dayReportTooFewPayload(access.entitlement, access.sessionCount, date));
      }
      return res.status(402).json(denialPayload(access.code, access.entitlement, access));
    }

    // Same legacy gap as the single-session report: a day report picks the
    // first session that already has a track map, so a day of legacy
    // sessions renders without one. Backfill any that are missing it.
    for (const s of daySessions) {
      if (hasTrackMap(s.analysisData)) continue;
      try {
        const bf = backfillTrackMap(s);
        if (bf.session) s.analysisData = bf.session.analysisData;
      } catch (err) {
        console.error('[sessions] day-report track map backfill failed:', err.message);
      }
    }

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
