import express from 'express';
import PDFDocument from 'pdfkit';
import { getSessionById } from '../lib/db.js';
import { verifyReportToken } from '../lib/reportLink.js';

const router = express.Router();

// GET /api/device/sessions/:id/report?token=<signed> — stream PDF.
// Browser navigation can't send auth headers, so this route is protected by a
// short-lived signed token minted by an authed endpoint (rider or admin). A bare
// request with no valid token is rejected (closes the open-report privacy hole).
// Admin key in the X-Admin-Key/Bearer header also grants access (for the admin panel).
router.get('/sessions/:id/report', (req, res) => {
  try {
    // Accept EITHER a valid signed token OR a valid admin key.
    const adminKey = req.headers['x-admin-key']
      || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
          ? req.headers.authorization.slice(7) : null);
    const isAdmin = !!process.env.ADMIN_KEY && adminKey === process.env.ADMIN_KEY;
    if (!isAdmin) {
      const v = verifyReportToken(req.params.id, req.query.token);
      if (!v.ok) {
        const status = v.reason === 'expired' ? 410 : 403;
        return res.status(status).json({
          error: v.reason === 'expired' ? 'This report link has expired' : 'A valid report link is required',
          reason: v.reason
        });
      }
    }

    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const analysis = session.analysisData || {};
    const summary  = analysis.summary  || {};
    const metrics  = analysis.metrics  || {};
    const laps     = analysis.laps     || [];
    const lapStats = analysis.lapStats || {};

    // Human-readable times
    const fmtTime = (seconds) => {
      if (!seconds && seconds !== 0) return '--';
      const total = Math.round(seconds * 100) / 100;
      if (total < 60) return `${total.toFixed(2)}s`;
      const m = Math.floor(total / 60);
      const s = (total % 60).toFixed(2);
      return `${m}:${String(s).padStart(5, '0')}`;
    };
    const fmtSpeed = (v) => (!v ? '--' : `${Math.round(v)} km/h`);
    const fmtDist = (v) => (!v ? '--' : `${v.toFixed(2)} km`);

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="MotoTrackIQ-${session.riderName || 'session'}-${session.date || 'report'}.pdf"`);
    doc.pipe(res);

    // ── Header bar ──────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 70).fill('#0d0d0d');
    doc.fillColor('#ffffff')
       .fontSize(22).font('Helvetica-Bold')
       .text('MotoTrackIQ', 40, 18, { continued: false })
       .fontSize(10).font('Helvetica')
       .fillColor('#ff6b35')
       .text('RACE ANALYSIS REPORT', 40, 44);

    // Right-side metadata
    doc.fillColor('#aaaaaa').fontSize(9)
       .text(`Date: ${session.date || '—'}`, doc.page.width - 180, 20, { width: 140, align: 'right' })
       .text(`Device: ${session.deviceName || '—'}`, doc.page.width - 180, 34, { width: 140, align: 'right' })
       .text(`Rider: ${session.riderName || '—'}`, doc.page.width - 180, 48, { width: 140, align: 'right' });

    let y = 90;

    // ── Summary block ───────────────────────────────────────────────────────
    const summaryBoxes = [
      { label: 'Total Laps',  value: summary.lapCount ?? laps.length ?? 0 },
      { label: 'Best Lap',    value: fmtTime(lapStats.best || summary.bestLap) },
      { label: 'Avg Lap',     value: fmtTime(lapStats.average) },
      { label: 'Top Speed',   value: fmtSpeed(metrics.maxSpeed) },
      { label: 'Avg Speed',   value: fmtSpeed(metrics.avgSpeed) },
      { label: 'Distance',    value: fmtDist(metrics.totalDistance) },
    ];

    const boxW = (doc.page.width - 80) / 3;
    const boxH = 52;
    summaryBoxes.forEach((box, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const bx  = 40 + col * (boxW + 6);
      const by  = y + row * (boxH + 6);
      doc.rect(bx, by, boxW, boxH).fill('#1a1a1a');
      doc.fillColor('#ff6b35').fontSize(20).font('Helvetica-Bold')
         .text(box.value, bx + 8, by + 8, { width: boxW - 16, align: 'center' })
         .fontSize(9).font('Helvetica').fillColor('#888888')
         .text(box.label, bx + 8, by + 32, { width: boxW - 16, align: 'center' });
    });

    y += Math.ceil(summaryBoxes.length / 3) * (boxH + 6) + 20;

    // ── Track / bike ────────────────────────────────────────────────────────
    if (session.track || session.bike) {
      doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
         .text('Track Session Details', 40, y);
      y += 16;
      if (session.track) {
        doc.fillColor('#ff6b35').fontSize(10).font('Helvetica-Bold')
           .text(`Track: `, 40, y, { continued: true })
           .fillColor('#cccccc').font('Helvetica').text(session.track);
        y += 14;
      }
      if (session.bike) {
        doc.fillColor('#ff6b35').fontSize(10).font('Helvetica-Bold')
           .text(`Bike: `, 40, y, { continued: true })
           .fillColor('#cccccc').font('Helvetica').text(session.bike);
        y += 14;
      }
      y += 6;
    }

    // ── Lap table ────────────────────────────────────────────────────────────
    if (laps.length > 0) {
      doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
         .text('Lap Breakdown', 40, y);
      y += 18;

      // Table header
      const cols = [40, 100, 170, 250, 330, 410];
      const headers = ['#', 'Lap Time', 'Max Speed', 'Avg Speed', 'Top G', 'Distance'];
      const colW    = [50, 70, 80, 80, 80, 80];

      doc.rect(40, y, doc.page.width - 80, 20).fill('#252525');
      doc.fillColor('#ff6b35').fontSize(8).font('Helvetica-Bold');
      headers.forEach((h, i) => {
        doc.text(h, cols[i] + 4, y + 5, { width: colW[i] });
      });
      y += 20;

      laps.forEach((lap, idx) => {
        if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
        const bg = idx % 2 === 0 ? '#141414' : '#1a1a1a';
        doc.rect(40, y, doc.page.width - 80, 18).fill(bg);
        doc.fillColor('#cccccc').fontSize(9).font('Helvetica')
           .text(String(lap.lapNumber ?? idx + 1), cols[0] + 4, y + 4, { width: colW[0] })
           .fillColor('#ffffff').font('Helvetica-Bold')
           .text(fmtTime(lap.time), cols[1] + 4, y + 4, { width: colW[1] })
           .fillColor('#cccccc').font('Helvetica')
           .text(fmtSpeed(lap.maxSpeed), cols[2] + 4, y + 4, { width: colW[2] })
           .text(fmtSpeed(lap.avgSpeed), cols[3] + 4, y + 4, { width: colW[3] })
           .text(`${(lap.maxG || 0).toFixed(1)}g`, cols[4] + 4, y + 4, { width: colW[4] })
           .text(fmtDist(lap.distance), cols[5] + 4, y + 4, { width: colW[5] });
        y += 18;
      });
    } else {
      doc.fillColor('#888888').fontSize(10)
         .text('No lap data available for this session.', 40, y);
      y += 20;
    }

    // ── Data Quality / Source ────────────────────────────────────────────────
    // Flags which fields are MEASURED vs ESTIMATED based on what the source
    // telemetry actually contained. Helps distinguish RaceBox-native captures
    // from third-party / mock exports that lack timestamps or full IMU data.
    {
      const fmt = summary.format || 'unknown';
      const hasTimestamps = summary.sessionDuration > 0;
      const hasLean = (analysis.summary && analysis.summary.hasLeanAngle) ||
                      laps.some(l => l.maxLean || l.leanAngle);
      const hasAlt = metrics.maxAltitude != null || metrics.elevationGain != null;

      if (y > doc.page.height - 170) { doc.addPage(); y = 40; }
      y += 6;
      doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
         .text('Data Quality & Source', 40, y);
      y += 16;

      const sourceLabel =
        fmt === 'racebox' ? 'RaceBox CSV (native capture)' :
        fmt === 'standard-headered' ? 'Third-party / generic CSV export' :
        fmt === 'standard' ? 'Generic CSV' : fmt;

      const lines = [
        ['Source format', sourceLabel, true],
        ['Lap times', hasTimestamps
            ? 'Measured (from capture timestamps)'
            : 'ESTIMATED — derived from GPS distance ÷ avg speed (no timestamps in data)',
          hasTimestamps],
        ['Speed / GPS line', 'Measured', true],
        ['Distance & sectors', 'Measured (GPS-derived)', true],
        ['Lean angle', hasLean ? 'Measured' : 'Not present in source', hasLean],
        ['Elevation', hasAlt ? 'Measured' : 'Not present in source', hasAlt],
        ['Braking / accel G', 'Verify axis convention with source device', false],
      ];

      lines.forEach(([label, val, ok]) => {
        if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
        doc.fillColor(ok ? '#4caf50' : '#ff6b35').fontSize(9).font('Helvetica-Bold')
           .text(ok ? '✓' : '!', 40, y, { width: 12 });
        doc.fillColor('#cccccc').fontSize(9).font('Helvetica-Bold')
           .text(`${label}: `, 54, y, { continued: true })
           .fillColor('#999999').font('Helvetica').text(val, { width: doc.page.width - 110 });
        y += 13;
      });
      y += 4;
      if (!hasTimestamps) {
        if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
        doc.fillColor('#888888').fontSize(8).font('Helvetica-Oblique')
           .text('Note: Absolute lap times and braking-G are indicative. For verified timing, supply a capture that includes timestamps and full IMU data (e.g. RaceBox-native CSV).', 40, y, { width: doc.page.width - 80 });
        y += 24;
      }
    }

    // ── Footer ──────────────────────────────────────────────────────────────
    const pageBottom = doc.page.height - 30;
    doc.rect(0, pageBottom - 10, doc.page.width, 40).fill('#0d0d0d');
    doc.fillColor('#555555').fontSize(8).font('Helvetica')
       .text('Generated by MotoTrackIQ', 40, pageBottom, { width: 200 })
       .text(`${new Date().toLocaleDateString('en-CA')} — mototrackiq.com`, doc.page.width - 180, pageBottom, { width: 140, align: 'right' });

    doc.end();
  } catch (err) {
    console.error('[device-report]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
