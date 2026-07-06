'use strict';

import PDFDocument from 'pdfkit';

const BRAND = {
  primary:   '#f97316',  // orange
  secondary: '#38bdf8',  // blue
  dark:      '#000000',
  muted:     '#888888',
  accent:    '#38bdf8',
  danger:    '#ef4444',
  success:   '#22c55e'
};

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(3);
  return m > 0 ? `${m}:${String(s).padStart(6, '0')}` : `${s}s`;
}

function round(n, d = 0) { return Math.round(n * 10 ** d) / 10 ** d; }

// Determine if a session is AM or PM from its analysisData timestamp.
// Falls back to the session's createdAt.
function sessionPeriod(session) {
  try {
    const ts = session.analysisData?.summary?.sessionDate;
    if (ts) {
      const h = new Date(ts).getHours();
      return h < 12 ? 'AM' : 'PM';
    }
  } catch (_) {}
  // fallback: use createdAt
  const h = new Date(session.createdAt).getHours();
  return h < 12 ? 'AM' : 'PM';
}

// Build day progress data from an array of session objects.
export function buildDayProgress(sessions) {
  // Group by period
  const byPeriod = { AM: [], PM: [] };
  sessions.forEach(s => {
    const p = sessionPeriod(s);
    byPeriod[p].push(s);
  });

  const allLaps = sessions.flatMap(s => (s.analysisData?.laps || []).map(l => ({
    ...l,
    sessionId: s.id,
    period: sessionPeriod(s)
  })));

  const allStats = sessions.flatMap(s => {
    const ls = s.analysisData?.lapStats;
    return ls ? [ls] : [];
  });

  // Best lap across all sessions
  const allBest = allStats.map(s => s.best).filter(t => t > 0);
  const dayBest = allBest.length ? Math.min(...allBest) : null;

  // AM best / PM best
  const amStats = byPeriod.AM.flatMap(s => (s.analysisData?.lapStats ? [s.analysisData.lapStats] : []));
  const pmStats = byPeriod.PM.flatMap(s => (s.analysisData?.lapStats ? [s.analysisData.lapStats] : []));
  const amBest = amStats.length ? Math.min(...amStats.map(s => s.best).filter(t => t > 0)) : null;
  const pmBest = pmStats.length ? Math.min(...pmStats.map(s => s.best).filter(t => t > 0)) : null;

  // Improvement: AM → PM
  let improvement = null;
  if (amBest && pmBest && pmBest < amBest) {
    improvement = { from: amBest, to: pmBest, delta: amBest - pmBest };
  }

  // Overall stats
  const dayMetrics = sessions.reduce((acc, s) => {
    const m = s.analysisData?.metrics || {};
    return {
      maxSpeed: Math.max(acc.maxSpeed, m.maxSpeed || 0),
      avgSpeed: acc.count > 0
        ? (acc.avgSpeed * acc.count + (m.avgSpeed || 0)) / (acc.count + 1)
        : (m.avgSpeed || 0),
      count: acc.count + 1
    };
  }, { maxSpeed: 0, avgSpeed: 0, count: 0 });

  // Total laps
  const totalLaps = allLaps.length;

  // Coached improvement note
  const notes = [];
  if (improvement) {
    notes.push({
      icon: '[★]', iconPdf: '[*]',
      title: `Afternoon improvement: -${improvement.delta.toFixed(2)}s`,
      text: `You cut ${improvement.delta.toFixed(2)}s from AM to PM (${fmtTime(amBest)} -> ${fmtTime(pmBest)}). That kind of session-on-session gain usually means the bike was dialed in and your references got sharper.`
    });
  }
  if (amBest && pmBest && pmBest > amBest) {
    notes.push({
      icon: '[!]', iconPdf: '[!]',
      title: `Afternoon was slower: +${(pmBest - amBest).toFixed(2)}s`,
      text: `PM best (${fmtTime(pmBest)}) was slower than AM (${fmtTime(amBest)}). Classic signs: fatigue, tyre drop-off, or too many laps without a reset. Consider a shorter PM session or a cool-down lap between stints.`
    });
  }
  if (byPeriod.AM.length >= 1 && byPeriod.PM.length >= 1) {
    const amTop = Math.max(...amStats.map(s => s.best));
    const pmTop = Math.max(...pmStats.map(s => s.best));
    notes.push({
      icon: '[>>]', iconPdf: '[>>]',
      title: 'Top speed of the day',
      text: `Peak speed reached: ${Math.round(dayMetrics.maxSpeed)} km/h across ${sessions.length} session${sessions.length === 1 ? '' : 's'}.`
    });
  }
  if (!improvement && !amBest && !pmBest) {
    notes.push({
      icon: '[i]', iconPdf: '[i]',
      title: 'Upload more sessions to track progress',
      text: `Track your AM to PM improvement over a full day at the circuit. Each session you upload builds the picture of your progression.`
    });
  }

  return {
    periods: {
      AM: byPeriod.AM.map(s => ({
        id: s.id, name: s.name, track: s.track || s.analysisData?.summary?.trackName,
        date: s.date || s.analysisData?.summary?.sessionDate,
        lapCount: s.analysisData?.lapStats?.count || 0,
        bestLap: s.analysisData?.lapStats?.best || null,
        laps: s.analysisData?.laps || [],
        metrics: s.analysisData?.metrics || {}
      })),
      PM: byPeriod.PM.map(s => ({
        id: s.id, name: s.name, track: s.track || s.analysisData?.summary?.trackName,
        date: s.date || s.analysisData?.summary?.sessionDate,
        lapCount: s.analysisData?.lapStats?.count || 0,
        bestLap: s.analysisData?.lapStats?.best || null,
        laps: s.analysisData?.laps || [],
        metrics: s.analysisData?.metrics || {}
      }))
    },
    summary: {
      trackName: sessions[0]?.track || sessions[0]?.analysisData?.summary?.trackName || 'Unknown Track',
      sessionDate: sessions[0]?.date || sessions[0]?.analysisData?.summary?.sessionDate,
      totalSessions: sessions.length,
      totalLaps,
      dayBest: dayBest ? { time: dayBest, formatted: fmtTime(dayBest) } : null,
      dayMaxSpeed: Math.round(dayMetrics.maxSpeed),
      dayAvgSpeed: Math.round(dayMetrics.avgSpeed),
      amBest: amBest ? { time: amBest, formatted: fmtTime(amBest) } : null,
      pmBest: pmBest ? { time: pmBest, formatted: fmtTime(pmBest) } : null,
      improvement: improvement
        ? { from: improvement.from, to: improvement.to, delta: improvement.delta, formatted: `-${improvement.delta.toFixed(2)}s` }
        : null
    },
    notes
  };
}

// Generate a Day Progress PDF report.
export async function generateDayReport(dayData, options = {}) {
  const { riderName = 'Rider', bikeName = '' } = options;
  const doc = new PDFDocument({ size: 'A4', margin: 0,
    info: { Title: `MotoTrackIQ Day Progress — ${dayData.summary.trackName}`, Author: 'MotoTrackIQ', Subject: 'Track Day Progress' }
  });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const C = BRAND;
  const PW = doc.page.width;
  const AM = dayData.periods.AM;
  const PM = dayData.periods.PM;

  // ── PAGE 1: Cover + Summary ──────────────────────────────────────────────
  // Dark header
  doc.rect(0, 0, PW, 130).fill(C.dark);
  doc.rect(0, 0, 6, 130).fill(C.primary);

  doc.font('Helvetica-Bold', 24).fillColor(C.primary)
     .text('MotoTrackIQ', 40, 28, { lineBreak: false });
  doc.font('Helvetica', 11).fillColor(C.muted)
     .text('Track Day Analytics', 40, 58);

  doc.font('Helvetica', 9).fillColor(C.muted)
     .text('DAY PROGRESS REPORT', PW - 40, 28, { align: 'right', lineBreak: false });

  const sd = dayData.summary.sessionDate
    ? new Date(dayData.summary.sessionDate).toLocaleDateString('en-CA', { year:'numeric', month:'long', day:'numeric' })
    : '';
  doc.font('Helvetica', 10).fillColor(C.muted)
     .text(sd, PW - 40, 46, { align: 'right' });

  doc.moveTo(40, 90).lineTo(PW - 40, 90).stroke(C.muted + '44');

  doc.font('Helvetica-Bold', 20).fillColor('#ffffff')
     .text(dayData.summary.trackName, 40, 100);
  doc.font('Helvetica', 10).fillColor(C.muted)
     .text([riderName, bikeName].filter(Boolean).join(' · '), 40, 126);

  // ── Day Stats Row ───────────────────────────────────────────────────────
  const statsY = 155;
  const stats = [
    { label: 'Sessions', value: dayData.summary.totalSessions, color: C.secondary },
    { label: 'Total Laps', value: dayData.summary.totalLaps, color: C.secondary },
    { label: 'Day Best', value: dayData.summary.dayBest?.formatted || '—', color: C.primary },
    { label: 'Top Speed', value: `${dayData.summary.dayMaxSpeed || 0} km/h`, color: C.primary },
    { label: 'AM Best', value: dayData.summary.amBest?.formatted || '—', color: C.muted },
    { label: 'PM Best', value: dayData.summary.pmBest?.formatted || '—', color: C.muted }
  ];
  const statW = (PW - 80) / stats.length;
  stats.forEach((s, i) => {
    const x = 40 + i * statW;
    doc.font('Helvetica-Bold', 18).fillColor(s.color)
       .text(String(s.value), x, statsY, { width: statW, align: 'center', lineBreak: false });
    doc.font('Helvetica', 8).fillColor(C.muted)
       .text(s.label, x, statsY + 22, { width: statW, align: 'center' });
  });

  // Improvement banner
  if (dayData.summary.improvement) {
    const imp = dayData.summary.improvement;
    const bannerY = statsY + 52;
    doc.rect(40, bannerY, PW - 80, 50).fill('#0d1f0d');
    doc.rect(40, bannerY, 4, 50).fill(C.success);
    doc.font('Helvetica-Bold', 16).fillColor(C.success)
       .text(`PM improved by ${imp.formatted}  (${fmtTime(imp.from)} -> ${fmtTime(imp.to)})`, 54, bannerY + 14, { width: PW - 100 });
    doc.font('Helvetica', 9).fillColor(C.muted)
       .text('You were faster in the afternoon — track time is paying off.', 54, bannerY + 34);
  } else if (dayData.summary.pmBest && dayData.summary.amBest) {
    const imp = dayData.summary.improvement;
    const bannerY = statsY + 52;
    doc.rect(40, bannerY, PW - 80, 50).fill('#1f0d0d');
    doc.rect(40, bannerY, 4, 50).fill(C.danger);
    doc.font('Helvetica-Bold', 16).fillColor(C.danger)
       .text(`PM was +${(dayData.summary.pmBest.time - dayData.summary.amBest.time).toFixed(2)}s vs AM`, 54, bannerY + 14, { width: PW - 100 });
    doc.font('Helvetica', 9).fillColor(C.muted)
       .text('Look at fatigue management or bike setup for the PM session.', 54, bannerY + 34);
  }

  // ── AM vs PM Lap Times ──────────────────────────────────────────────────
  const lapY = (dayData.summary.improvement || (dayData.summary.pmBest && dayData.summary.amBest)) ? statsY + 120 : statsY + 62;

  doc.font('Helvetica-Bold', 11).fillColor('#ffffff')
     .text('LAP TIMES — AM vs PM', 40, lapY);

  doc.moveTo(40, lapY + 18).lineTo(PW - 40, lapY + 18).stroke(C.muted + '33');

  // Build combined lap table: all AM laps + all PM laps
  const amLaps = AM.flatMap(s => s.laps.map(l => ({ ...l, period: 'AM', session: s.name || 'AM' })));
  const pmLaps = PM.flatMap(s => s.laps.map(l => ({ ...l, period: 'PM', session: s.name || 'PM' })));
  const allCombined = [...amLaps, ...pmLaps];

  if (allCombined.length > 0) {
    const tableTop = lapY + 24;
    const cols = [40, 90, 180, 270, 360, 450];
    const hdrs = ['Period', 'Lap', 'Time', 'Top Speed', 'Braking G', 'Cornering G'];
    doc.font('Helvetica-Bold', 8).fillColor(C.muted);
    hdrs.forEach((h, i) => doc.text(h, cols[i], tableTop, { width: 80 }));
    doc.moveTo(40, tableTop + 12).lineTo(PW - 40, tableTop + 12).stroke(C.muted + '33');

    // Find overall best
    const times = allCombined.map(l => l.time ?? l.lapTime ?? 0).filter(t => t > 0);
    const overallBest = times.length ? Math.min(...times) : null;

    allCombined.forEach((lap, i) => {
      const rowY = tableTop + 18 + i * 16;
      const t = lap.time ?? lap.lapTime ?? 0;
      const isBest = overallBest && t === overallBest && t > 0;
      const periodColor = lap.period === 'AM' ? C.secondary : C.primary;
      doc.font('Helvetica', 9).fillColor(periodColor)
         .text(lap.period, cols[0], rowY, { width: 40 })
         .text(`${lap.lapNumber || lap.lap || i + 1}`, cols[1], rowY, { width: 80 })
         .text(t > 0 ? fmtTime(t) : '—', cols[2], rowY, { width: 80 })
         .text(`${Math.round(lap.maxSpeed || lap.topSpeed || 0)} km/h`, cols[3], rowY, { width: 80 })
         .text(`${(lap.maxG || 0).toFixed(1)}G`, cols[4], rowY, { width: 80 })
         .text(`${(lap.maxG || 0).toFixed(1)}G`, cols[5], rowY, { width: 80 });
      if (isBest) {
        doc.font('Helvetica-Bold', 8).fillColor(C.accent)
           .text('BEST', cols[2] + 55, rowY + 1, { width: 40 });
      }
    });
  }

  // ── Coaching Notes (flow after lap table) ───────────────────────────────
  const coachY = Math.max(doc.y + 24, doc.page.height - 260);
  if (dayData.notes && dayData.notes.length > 0) {
    doc.font('Helvetica-Bold', 11).fillColor('#ffffff')
       .text('AI COACHING NOTES', 40, coachY);
    doc.moveTo(40, coachY + 14).lineTo(PW - 40, coachY + 14).stroke(C.muted + '33');

    let y = coachY + 22;
    dayData.notes.slice(0, 4).forEach(note => {
      if (y > doc.page.height - 100) return;
      doc.font('Helvetica-Bold', 10).fillColor(C.dark)
         .text(`${note.iconPdf || note.icon || '[*]'}  ${note.title}`, 40, y, { width: PW - 80 });
      y = doc.y + 2;
      doc.font('Helvetica', 9).fillColor('#444444')
         .text(note.text, 40, y, { width: PW - 80, lineGap: 2 });
      y += 30;
    });
  }

  // Footer
  const footerY = doc.page.height - 30;
  doc.moveTo(40, footerY).lineTo(PW - 40, footerY).stroke(C.muted + '22');
  doc.font('Helvetica', 8).fillColor(C.muted)
     .text('Powered by MotoTrackIQ — AI Track Day Analytics', 40, footerY + 8)
     .text('mototrackiq.com', PW - 120, footerY + 8);

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export default { buildDayProgress, generateDayReport };
