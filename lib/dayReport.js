'use strict';

import PDFDocument from 'pdfkit';
import { drawCoachingDisclaimer, renderTrackMap } from './reportGenerator.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRAND = {
  primary:   '#f97316',
  secondary: '#38bdf8',
  dark:      '#1a1a2e',
  muted:     '#888888',
  accent:    '#38bdf8',
  danger:    '#ef4444',
  success:   '#22c55e'
};

// Load logo — fall back gracefully
let LOGO_DATA = null;
try {
  const logoPath = join(__dirname, 'mototrackiq-logo.png');
  LOGO_DATA = readFileSync(logoPath);
} catch (_) {}

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(3);
  return m > 0 ? `${m}:${String(s).padStart(6,'0')}` : `${s}s`;
}

// Get hour in local (Eastern) timezone for AM/PM period determination
function localHour(sessionDateStr) {
  try {
    // Format as Eastern time and extract the hour
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', hour12: false });
    const parts = fmt.formatToParts(new Date(sessionDateStr));
    const h = parseInt(parts.find(p => p.type === 'hour')?.value || '12');
    return h;
  } catch (_) {}
  return new Date(sessionDateStr).getUTCHours(); // fallback to UTC
}
function fmtSpeed(kmh) { return kmh ? `${Math.round(kmh)} km/h` : '—'; }
function round(n, d=0) { return Math.round(n * 10**d) / 10**d; }

// ── Session period (Eastern time) ──────────────────────────────────
function sessionPeriod(session) {
  try {
    const ts = session.analysisData?.summary?.sessionDate;
    if (ts) return localHour(ts) < 12 ? 'AM' : 'PM';
  } catch (_) {}
  try {
    return localHour(session.createdAt) < 12 ? 'AM' : 'PM';
  } catch (_) {}
  return 'AM';
}

// ── Sector aggregate ─────────────────────────────────────────────────
function buildSectorAggregate(sessions) {
  const sectors = { 1: [], 2: [], 3: [] };
  sessions.forEach(s => {
    const laps = s.analysisData?.laps || [];
    if (!laps.length) return;
    const best = laps.reduce((b, l) => (!b || l.time < b.time) ? l : b, null);
    if (!best?.sectors) return;
    best.sectors.forEach(sec => { if (sectors[sec.sector]) sectors[sec.sector].push(sec); });
  });
  return Object.fromEntries(
    Object.entries(sectors).map(([num, secs]) => {
      if (!secs.length) return [num, null];
      const speeds = secs.map(s=>s.maxSpeed).filter(v=>v>0);
      const avgSpeeds = secs.map(s=>s.avgSpeed).filter(v=>v>0);
      const gs = secs.map(s=>s.maxG).filter(v=>v>0);
      return [num, {
        avgSpeed: avgSpeeds.length ? avgSpeeds.reduce((a,b)=>a+b,0)/avgSpeeds.length : null,
        maxSpeed: speeds.length ? Math.max(...speeds) : null,
        maxG: gs.length ? Math.max(...gs) : null,
      }];
    })
  );
}

// ── Day track map — use first session that has one ──────────────────────────
function buildDayTrackMap(sessionDetails) {
  for (const s of sessionDetails) {
    if (s.visualizations?.trackMap?.path?.length > 10) {
      return s.visualizations.trackMap;
    }
  }
  return null;
}

// ── Main builder ───────────────────────────────────────────────────
export function buildDayProgress(sessions) {
  const byPeriod = { AM: [], PM: [] };
  sessions.forEach(s => { byPeriod[sessionPeriod(s)].push(s); });

  const allLaps = sessions.flatMap(s =>
    (s.analysisData?.laps || []).map(l => ({ ...l, sessionId: s.id, period: sessionPeriod(s) }))
  );

  const allStats = sessions.flatMap(s =>
    s.analysisData?.lapStats ? [s.analysisData.lapStats] : []
  );

  const allBestTimes = allStats.map(s => s.best).filter(t => t > 0);
  const dayBest = allBestTimes.length ? Math.min(...allBestTimes) : null;

  const amStats = byPeriod.AM.flatMap(s => s.analysisData?.lapStats ? [s.analysisData.lapStats] : []);
  const pmStats = byPeriod.PM.flatMap(s => s.analysisData?.lapStats ? [s.analysisData.lapStats] : []);
  const amBest = amStats.length ? Math.min(...amStats.map(s=>s.best).filter(t=>t>0)) : null;
  const pmBest = pmStats.length ? Math.min(...pmStats.map(s=>s.best).filter(t=>t>0)) : null;

  const improvement = (amBest && pmBest && pmBest < amBest)
    ? { from: amBest, to: pmBest, delta: amBest - pmBest }
    : null;

  const dayMetrics = sessions.reduce((acc, s) => {
    const m = s.analysisData?.metrics || {};
    return {
      maxSpeed: Math.max(acc.maxSpeed, m.maxSpeed || 0),
      avgSpeed: acc.count > 0
        ? (acc.avgSpeed * acc.count + (m.avgSpeed||0)) / (acc.count+1)
        : (m.avgSpeed||0),
      count: acc.count + 1,
      maxG: Math.max(acc.maxG, m.maxG || 0),
    };
  }, { maxSpeed: 0, avgSpeed: 0, count: 0, maxG: 0 });

  const sectorAgg = buildSectorAggregate(sessions);

  const sessionDetails = sessions.map(s => {
    const laps = s.analysisData?.laps || [];
    const stats = s.analysisData?.lapStats;
    const m = s.analysisData?.metrics || {};
    return {
      id: s.id,
      name: s.name || `Session`,
      period: sessionPeriod(s),
      track: s.track || s.analysisData?.summary?.trackName || 'Unknown',
      lapCount: stats?.count || laps.length || 0,
      bestLap: stats?.best || null,
      bestLapFormatted: stats?.best ? fmtTime(stats.best) : '—',
      topSpeed: m.maxSpeed || 0,
      avgSpeed: m.avgSpeed || 0,
      maxG: m.maxG || 0,
      consistency: stats?.consistency || '—',
      laps,
      coaching: s.analysisData?.coaching || null,
      visualizations: s.analysisData?.visualizations || {},  // for track map
    };
  });

  const notes = [];
  if (improvement) {
    notes.push({ iconPdf: '[*]', title: `PM improved by ${improvement.delta.toFixed(2)}s`,
      text: `You cut ${improvement.delta.toFixed(2)}s from AM to PM (${fmtTime(amBest)} → ${fmtTime(pmBest)}). That kind of session-on-session gain usually means the bike was dialed in and your references got sharper.` });
  }
  if (amBest && pmBest && pmBest > amBest) {
    notes.push({ iconPdf: '[!]', title: `PM was +${(pmBest - amBest).toFixed(2)}s vs AM`,
      text: `Classic signs: fatigue, tyre drop-off, or too many laps without a reset. Consider a shorter PM session or a cool-down lap between stints.` });
  }
  if (dayMetrics.maxSpeed > 0) {
    notes.push({ iconPdf: '[>>]', title: `Peak speed: ${Math.round(dayMetrics.maxSpeed)} km/h`,
      text: `Reached across ${sessions.length} session${sessions.length===1?'':'s'}. If trap speed trails similar machinery, the time is usually made on corner exit — get the bike picked up and on throttle earlier.` });
  }
  sessions.forEach(s => {
    const coachingNotes = s.analysisData?.coaching?.notes || [];
    coachingNotes.slice(0, 2).forEach(n => {
      if (notes.length >= 5) return;
      notes.push({ iconPdf: n.iconPdf||n.icon||'[*]', title: n.title, text: n.text });
    });
  });

  return {
    summary: {
      trackName: sessions[0]?.track || sessions[0]?.analysisData?.summary?.trackName || 'Unknown Track',
      sessionDate: sessions[0]?.date || sessions[0]?.analysisData?.summary?.sessionDate,
      totalSessions: sessions.length,
      totalLaps: allLaps.length,
      dayBest: dayBest ? { time: dayBest, formatted: fmtTime(dayBest) } : null,
      dayMaxSpeed: Math.round(dayMetrics.maxSpeed),
      dayAvgSpeed: Math.round(dayMetrics.avgSpeed),
      dayMaxG: dayMetrics.maxG,
      amBest: amBest ? { time: amBest, formatted: fmtTime(amBest) } : null,
      pmBest: pmBest ? { time: pmBest, formatted: fmtTime(pmBest) } : null,
      improvement: improvement
        ? { from: improvement.from, to: improvement.to, delta: improvement.delta, formatted: `-${improvement.delta.toFixed(2)}s` }
        : null,
    },
    periods: {
      AM: byPeriod.AM.map(s => ({ id:s.id, name:s.name, lapCount:s.analysisData?.lapStats?.count||0, bestLap:s.analysisData?.lapStats?.best||null, laps:s.analysisData?.laps||[], metrics:s.analysisData?.metrics||{}, coaching:s.analysisData?.coaching||null })),
      PM: byPeriod.PM.map(s => ({ id:s.id, name:s.name, lapCount:s.analysisData?.lapStats?.count||0, bestLap:s.analysisData?.lapStats?.best||null, laps:s.analysisData?.laps||[], metrics:s.analysisData?.metrics||{}, coaching:s.analysisData?.coaching||null })),
    },
    sessionDetails,
    sectorAgg,
    notes: notes.slice(0, 5),
    trackMap: buildDayTrackMap(sessionDetails),
  };
}

// ── PDF Renderer ───────────────────────────────────────────────────
export async function generateDayReport(dayData, options = {}) {
  const { riderName = 'Rider', bikeName = '' } = options;
  const doc = new PDFDocument({
    size: 'A4', margin: 40,
    info: { Title: `MotoTrackIQ Day Progress — ${dayData.summary.trackName}`, Author: 'MotoTrackIQ', Subject: 'Track Day Progress' }
  });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const C = BRAND;
  const PW = doc.page.width;        // 595.28
  const PH = doc.page.height;       // 841.89
  const ML = 40;                    // left margin
  const MR = PW - 40;             // right margin (for text width = PW-80)
  const TW = PW - 80;             // usable text width

  // ── Page helper ────────────────────────────────────────────────
  // NOTE: drawFooter / drawHeader / addPage override are defined BELOW
  // but hoisted via function declarations so checkPage() can trigger
  // page breaks that correctly stamp footer+header during content drawing.
  function checkPage(y, minFree = 100) {
    if (y + minFree > PH - 40) { return doc.addPage(); }
    return y;
  }

  // ── Shared footer (stamped on every page) ──────────────────────
  function drawFooter() {
    doc.moveTo(ML, PH - 36).lineTo(MR, PH - 36).stroke(C.muted + '44');
    doc.font('Helvetica', 7.5).fillColor(C.muted)
       .text('AI-powered track day analytics  \u00b7  mototrackiq.com  \u00b7  Generate your own report  \u00b7  MotoTrackIQ  \u00b7  Track smarter. Go faster.', ML, PH - 30, { width: TW, align: 'center', lineBreak: false, height: 12 });
    doc.font('Helvetica', 7.5).fillColor(C.muted)
       .text(`Generated ${new Date().toLocaleDateString('en-CA')}`, ML, PH - 18, { width: TW, align: 'center', lineBreak: false, height: 12 });
  }

  // ── Compact header (pages 2+) ──────────────────────────────────
  function drawHeader() {
    doc.rect(0, 0, PW, 70).fill(C.dark);
    doc.rect(0, 0, 5, 70).fill(C.primary);
    if (LOGO_DATA) {
      doc.image(LOGO_DATA, ML, 10, { width: 60, height: 38, fit: [60, 38] });
      doc.font('Helvetica-Bold', 14).fillColor(C.primary)
         .text('MotoTrackIQ', ML + 68, 14, { lineBreak: false });
      doc.font('Helvetica', 7).fillColor(C.muted)
         .text('Track Day Analytics', ML + 68, 32);
    } else {
      doc.font('Helvetica-Bold', 18).fillColor(C.primary)
         .text('MotoTrackIQ', ML, 12, { lineBreak: false });
      doc.font('Helvetica', 8).fillColor(C.muted)
         .text('Track Day Analytics', ML, 38);
    }
    doc.font('Helvetica', 7).fillColor(C.muted)
       .text('DAY PROGRESS REPORT', MR - 160, 14, { width: 160, align: 'right', lineBreak: false });
    const sdH = dayData.summary.sessionDate
      ? new Date(dayData.summary.sessionDate).toLocaleDateString('en-CA', { year:'numeric', month:'long', day:'numeric' })
      : '';
    doc.font('Helvetica', 8).fillColor(C.muted)
       .text(sdH, MR - 160, 28, { width: 160, align: 'right', lineBreak: false });
    doc.moveTo(ML, 72).lineTo(MR, 72).stroke(C.muted + '44');
    doc.font('Helvetica-Bold', 12).fillColor('#ffffff')
       .text(dayData.summary.trackName, ML, 78, { lineBreak: false });
    doc.font('Helvetica', 8).fillColor(C.muted)
       .text([riderName, bikeName].filter(Boolean).join(' \u00b7 '), ML + 200, 82, { lineBreak: false });
  }

  // Override addPage so EVERY page break (incl. mid-content via checkPage)
  // stamps the footer on the finished page and a header on the new one.
  // Guard prevents recursion when footer/header text itself auto-wraps a page.
  let _stamping = false;
  const origAddPage = doc.addPage.bind(doc);
  doc.addPage = function(opts) {
    if (_stamping) { return origAddPage(opts); }
    _stamping = true;
    drawFooter();
    origAddPage(opts);
    drawHeader();
    _stamping = false;
    doc.y = 100;
    return 100; // y cursor below compact header
  };

  // ── Header (page 1, full) ──────────────────────────────────────
  doc.rect(0, 0, PW, 90).fill(C.dark);
  doc.rect(0, 0, 5, 90).fill(C.primary);

  // Logo (left side)
  if (LOGO_DATA) {
    doc.image(LOGO_DATA, ML, 12, { width: 80, height: 50, fit: [80, 50] });
    doc.font('Helvetica-Bold', 18).fillColor(C.primary)
       .text('MotoTrackIQ', ML + 90, 24, { lineBreak: false });
    doc.font('Helvetica', 9).fillColor(C.muted)
       .text('Track Day Analytics', ML + 90, 48);
  } else {
    doc.font('Helvetica-Bold', 22).fillColor(C.primary)
       .text('MotoTrackIQ', ML, 20, { lineBreak: false });
    doc.font('Helvetica', 10).fillColor(C.muted)
       .text('Track Day Analytics', ML, 52);
  }

  doc.font('Helvetica', 8).fillColor(C.muted)
     .text('DAY PROGRESS REPORT', MR - 180, 20, { width: 180, align: 'right', lineBreak: false });
  const sd = dayData.summary.sessionDate
    ? new Date(dayData.summary.sessionDate).toLocaleDateString('en-CA', { year:'numeric', month:'long', day:'numeric' })
    : '';
  doc.font('Helvetica', 10).fillColor(C.muted)
     .text(sd, MR - 180, 38, { width: 180, align: 'right', lineBreak: false });

  doc.moveTo(ML, 95).lineTo(MR, 95).stroke(C.muted + '44');

  doc.font('Helvetica-Bold', 20).fillColor('#ffffff')
     .text(dayData.summary.trackName, ML, 102);
  doc.font('Helvetica', 10).fillColor(C.muted)
     .text([riderName, bikeName].filter(Boolean).join(' · '), ML, 126);

  let y = 150;

  // ── Track Map (combined day overlay) ─────────────────────────────
  if (dayData.trackMap) {
    y = checkPage(y, 240);
    doc.font('Helvetica-Bold', 10).fillColor(C.dark).text('TRACK MAP', ML, y);
    doc.moveTo(ML, y + 12).lineTo(MR, y + 12).stroke(C.muted + '33');
    y += 18;
    try {
      const mapW = Math.min(420, TW);
      const mapH = Math.round(mapW * 0.72);
      const mapImg = await renderTrackMap({ trackMap: dayData.trackMap }, mapW, mapH);
      if (mapImg) {
        doc.image(mapImg, ML, y, { width: mapW, height: mapH });
        y += mapH + 12;
      } else {
        y += 12;
      }
    } catch (e) {
      console.error('Track map render error:', e.message);
      y += 12;
    }
  }

  // ── Day Stats Row ─────────────────────────────────────────────
  const stats = [
    { label: 'Sessions', value: dayData.summary.totalSessions, color: C.secondary },
    { label: 'Total Laps', value: dayData.summary.totalLaps, color: C.secondary },
    { label: 'Day Best', value: dayData.summary.dayBest?.formatted || '—', color: C.primary },
    { label: 'Top Speed', value: `${dayData.summary.dayMaxSpeed || 0} km/h`, color: C.primary },
    { label: 'Day Avg', value: `${dayData.summary.dayAvgSpeed || 0} km/h`, color: C.muted },
    { label: 'Max G', value: dayData.summary.dayMaxG ? `${dayData.summary.dayMaxG.toFixed(1)}G` : '—', color: C.muted },
  ];
  const statW = TW / stats.length;
  stats.forEach((s, i) => {
    const x = ML + i * statW;
    doc.font('Helvetica-Bold', 16).fillColor(s.color)
       .text(String(s.value), x, y, { width: statW, align: 'center', lineBreak: false });
    doc.font('Helvetica', 8).fillColor(C.muted)
       .text(s.label, x, y + 22, { width: statW, align: 'center' });
  });
  y += 58;

  // ── AM vs PM Best ──────────────────────────────────────────────
  doc.rect(ML, y, TW/2 - 4, 46).fill(C.secondary + '22');
  doc.rect(ML + TW/2 + 4, y, TW/2 - 4, 46).fill(C.primary + '22');
  doc.font('Helvetica-Bold', 10).fillColor(C.secondary).text('AM BEST', ML + 10, y + 8);
  doc.font('Helvetica-Bold', 18).fillColor(C.secondary)
     .text(dayData.summary.amBest?.formatted || '—', ML + 10, y + 22);
  doc.font('Helvetica', 8).fillColor(C.muted)
     .text(`${dayData.periods.AM.length} session${dayData.periods.AM.length===1?'':'s'}`, ML + 90, y + 16);

  doc.font('Helvetica-Bold', 10).fillColor(C.primary).text('PM BEST', ML + TW/2 + 14, y + 8);
  doc.font('Helvetica-Bold', 18).fillColor(C.primary)
     .text(dayData.summary.pmBest?.formatted || '—', ML + TW/2 + 14, y + 22);
  doc.font('Helvetica', 8).fillColor(C.muted)
     .text(`${dayData.periods.PM.length} session${dayData.periods.PM.length===1?'':'s'}`, ML + TW/2 + 94, y + 16);
  y += 58;

  // ── Improvement Banner ──────────────────────────────────────────
  if (dayData.summary.improvement) {
    const imp = dayData.summary.improvement;
    doc.rect(ML, y, TW, 44).fill('#0d1f0d');
    doc.rect(ML, y, 4, 44).fill(C.success);
    doc.font('Helvetica-Bold', 13).fillColor(C.success)
       .text(`Afternoon improved by ${imp.formatted}  (${fmtTime(imp.from)} → ${fmtTime(imp.to)})`, ML + 14, y + 8, { width: TW - 20 });
    doc.font('Helvetica', 9).fillColor('#88cc88')
       .text('Track time is paying off — keep building that peak.', ML + 14, y + 28);
    y += 56;
  }

  // ── Per-Session Table ───────────────────────────────────────────
  // ── Per-Session Table ───────────────────────────────────────────
  doc.font('Helvetica-Bold', 10).fillColor(C.dark).text('SESSIONS', ML, y);
  doc.moveTo(ML, y + 12).lineTo(MR, y + 12).stroke(C.muted + '33');
  y += 18;

  // Column x positions: Period | Session Name | Laps | Best Lap | Top Speed | Consistency
  const sCols = [ML, ML+48, ML+170, ML+225, ML+290];
  const sW    = [44,      118,      52,       60,       TW - (ML+290-ML)];
  const sHdrs = ['Period', 'Session', 'Laps', 'Best', 'Top Speed'];
  doc.font('Helvetica-Bold', 8).fillColor(C.muted);
  sHdrs.forEach((h, i) => doc.text(h, sCols[i], y, { width: sW[i] }));
  doc.moveTo(ML, y + 12).lineTo(MR, y + 12).stroke(C.muted + '33');
  y += 16;

  dayData.sessionDetails.forEach((s) => {
    y = checkPage(y, 18);
    const pColor = s.period === 'AM' ? C.secondary : C.primary;
    doc.font('Helvetica-Bold', 9).fillColor(pColor).text(s.period, sCols[0], y, { width: sW[0] });
    // Split long session names manually to avoid PDFKit continued-text clipping
    const maxW = sW[1];
    const fs = 8;
    doc.font('Helvetica', fs).fillColor('#222222');
    const words = s.name.split(' ');
    let line = '';
    let dy = 0;
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      const w = doc.widthOfString(test);
      if (w > maxW && line) {
        doc.text(line, sCols[1], y + dy, { width: maxW, lineBreak: false });
        dy += fs + 1;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) doc.text(line, sCols[1], y + dy, { width: maxW, lineBreak: false });
    doc.font('Helvetica', 9).fillColor('#222222').text(`${s.lapCount}`, sCols[2], y, { width: sW[2], lineBreak: false });
    doc.font('Helvetica-Bold', 9).fillColor(C.primary).text(s.bestLapFormatted, sCols[3], y, { width: sW[3], lineBreak: false });
    doc.font('Helvetica', 9).fillColor('#222222').text(`${Math.round(s.topSpeed)} km/h`, sCols[4], y, { width: sW[4], lineBreak: false });
    y += 15;
  });
  y += 8;

  // ── Sector Analysis ─────────────────────────────────────────────
  y = checkPage(y, 100);
  doc.font('Helvetica-Bold', 10).fillColor(C.dark).text('SECTOR ANALYSIS', ML, y);
  doc.moveTo(ML, y + 12).lineTo(MR, y + 12).stroke(C.muted + '33');
  y += 18;

  // Sector col positions: Sector | Avg Speed | Top Speed | Max G
  const gCols = [ML, ML+55, ML+155, ML+260];
  const gW    = [50,       95,       100,       TW - (ML+260-ML)];
  const gHdrs = ['Sector', 'Avg Speed', 'Top Speed', 'Max G'];
  doc.font('Helvetica-Bold', 8).fillColor(C.muted);
  gHdrs.forEach((h, i) => doc.text(h, gCols[i], y, { width: gW[i] }));
  doc.moveTo(ML, y + 12).lineTo(MR, y + 12).stroke(C.muted + '33');
  y += 16;

  for (const [num, data] of Object.entries(dayData.sectorAgg)) {
    if (!data) continue;
    y = checkPage(y, 16);
    doc.font('Helvetica-Bold', 9).fillColor(C.primary).text(`S${num}`, gCols[0], y, { width: gW[0], lineBreak: false });
    doc.font('Helvetica', 9).fillColor('#222222').text(`${Math.round(data.avgSpeed)} km/h`, gCols[1], y, { width: gW[1], lineBreak: false });
    doc.fillColor('#222222').text(`${Math.round(data.maxSpeed)} km/h`, gCols[2], y, { width: gW[2], lineBreak: false });
    doc.fillColor('#222222').text(`${data.maxG.toFixed(2)}G`, gCols[3], y, { width: gW[3], lineBreak: false });
    y += 14;
  }
  y += 10;

  // ── Lap Times Table ─────────────────────────────────────────────
  y = checkPage(y, 100);
  doc.font('Helvetica-Bold', 10).fillColor(C.dark).text('LAP TIMES', ML, y);
  doc.moveTo(ML, y + 12).lineTo(MR, y + 12).stroke(C.muted + '33');
  y += 18;

  const allLaps = dayData.sessionDetails.flatMap(s =>
    s.laps.map(l => ({ ...l, period: s.period, sessionName: s.name }))
  );
  const times = allLaps.map(l => l.time).filter(t => t > 0);
  const overallBest = times.length ? Math.min(...times) : null;

  // Lap cols: Period | Lap | Time | Top Speed | Max G
  const lCols = [ML, ML+38, ML+80, ML+158, ML+230];
  const lW    = [34,      38,     74,       68,       TW - (ML+230-ML)];
  const lHdrs = ['Per', 'Lap', 'Time', 'Top Speed', 'Max G'];
  doc.font('Helvetica-Bold', 8).fillColor(C.muted);
  lHdrs.forEach((h, i) => doc.text(h, lCols[i], y, { width: lW[i] }));
  doc.moveTo(ML, y + 12).lineTo(MR, y + 12).stroke(C.muted + '33');
  y += 16;

  const maxLapRows = Math.min(allLaps.length, 18);
  for (let i = 0; i < maxLapRows; i++) {
    y = checkPage(y, 14);
    const lap = allLaps[i];
    const t = lap.time || 0;
    const isBest = overallBest && t === overallBest && t > 0;
    const pColor = lap.period === 'AM' ? C.secondary : C.primary;
    doc.font('Helvetica-Bold', 8).fillColor(pColor).text(lap.period, lCols[0], y, { width: lW[0], lineBreak: false });
    doc.font('Helvetica', 8).fillColor('#222222').text(`${lap.lapNumber || i+1}`, lCols[1], y, { width: lW[1], lineBreak: false });
    doc.font('Helvetica-Bold', 9).fillColor(isBest ? C.success : '#222222').text(t > 0 ? fmtTime(t) : '—', lCols[2], y, { width: lW[2], lineBreak: false });
    doc.font('Helvetica', 9).fillColor('#222222').text(`${Math.round(lap.maxSpeed||0)} km/h`, lCols[3], y, { width: lW[3], lineBreak: false });
    doc.fillColor('#222222').text(`${(lap.maxG||0).toFixed(1)}G`, lCols[4], y, { width: lW[4], lineBreak: false });
    if (isBest) {
      doc.font('Helvetica-Bold', 7).fillColor(C.success).text('BEST', MR - 30, y + 1, { width: 30, align: 'right', lineBreak: false });
    }
    y += 13;
  }
  y += 10;

  // ── AI Coaching Notes ───────────────────────────────────────────
  y = checkPage(y, 120);
  doc.font('Helvetica-Bold', 10).fillColor(C.dark).text('AI COACHING NOTES', ML, y);
  doc.moveTo(ML, y + 12).lineTo(MR, y + 12).stroke(C.muted + '33');
  y += 20;

  for (const note of dayData.notes.slice(0, 4)) {
    y = checkPage(y, 44);
    doc.font('Helvetica-Bold', 9).fillColor(C.primary)
       .text(`${note.iconPdf || '[*]'}  ${note.title}`, ML, y, { width: TW });
    y += 13;
    doc.font('Helvetica', 8.5).fillColor('#555555')
       .text(note.text, ML, y, { width: TW, lineGap: 1 });
    y += 26;
  }

  // Coaching disclaimer
  y = checkPage(y, 50);
  drawCoachingDisclaimer(doc, y, C);
  y += 20;

  // Stamp footer on the final page before closing.
  drawFooter();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export default { buildDayProgress, generateDayReport };
