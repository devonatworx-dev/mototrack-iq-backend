/**
 * MotoTrackIQ - PDF Report Generator
 * Takes analysis result → professional shareable PDF
 *
 * Layout is FLOW-BASED (uses a running `y` cursor + page-break guards) rather
 * than hardcoded absolute positions, so reports render completely regardless of
 * lap count. Field names match the analyzer output exactly:
 *   - laps[].time / .maxSpeed / .maxG / .sectors[].maxG
 *   - visualizations.speedTrace[].y
 *   - visualizations.gForceTrace[].y   (single combined G, capital F)
 *   - metrics.maxSpeed / .avgSpeed / .maxGForces.{braking,cornering}
 */

import PDFDocument from 'pdfkit';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import fs from 'fs';

const BRAND = {
  primary: '#ff6b35',    // MotoTrackIQ orange
  dark: '#1a1a2e',
  mid: '#2d2d44',
  light: '#f5f5f5',
  text: '#ffffff',
  muted: '#aaaaaa',
  accent: '#00d4aa',     // teal accent
  danger: '#ff4757',
  warning: '#ffa502'
};

// Page geometry (A4, 40pt side margins)
const MARGIN = 40;

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(seconds) {
  if (seconds == null || isNaN(seconds) || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(3);
  return m > 0 ? `${m}:${String(s).padStart(6, '0')}` : `${s}s`;
}

// PDFKit's built-in Helvetica can't render emoji/multibyte glyphs (they come out
// as mojibake). Coaching notes often carry an emoji icon, so replace anything
// outside the safe Latin range with a clean bullet for the PDF.
function pdfIcon(icon) {
  if (!icon) return '\u2022';
  // If the icon is a plain ASCII marker (e.g. '[*]', '-') keep it; otherwise bullet.
  return /^[\x20-\x7E]+$/.test(icon) ? icon : '\u2022';
}

// Strip emoji / astral-plane glyphs from body text so Helvetica doesn't render
// mojibake. Keeps normal accented Latin punctuation intact.
function pdfText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Consistency can be a number (percent) or a label like 'Medium'. Prefer a
// percent derived from stdDev vs best when we have numbers, else show the label.
function consistencyLabel(lapStats) {
  if (!lapStats) return '\u2014';
  const c = lapStats.consistency;
  if (typeof c === 'number' && isFinite(c)) return `${Math.round(c)}%`;
  if (lapStats.stdDev != null && lapStats.best) {
    const pct = Math.max(0, Math.min(100, 100 - (lapStats.stdDev / lapStats.best) * 100));
    return `${pct.toFixed(1)}%`;
  }
  return c ? String(c) : '\u2014';
}

function lapTimeOf(l) { return (l && (l.time ?? l.lapTime)) || 0; }
function lapSpeedOf(l) { return Math.round((l && (l.maxSpeed ?? l.topSpeed)) || 0); }
function lapGOf(l) { return (l && (l.maxG ?? l.maxCornering ?? l.maxBraking)) || 0; }

// ── Chart renderers ─────────────────────────────────────────────────────────

async function renderSpeedTraceChart(visualizations, width = 1160, height = 320) {
  const speedData = (visualizations && visualizations.speedTrace) || [];
  if (!speedData.length) return null;
  const chart = new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });
  const cfg = {
    type: 'line',
    data: {
      labels: speedData.map((_, i) => i),
      datasets: [{
        label: 'Speed (km/h)',
        data: speedData.map(p => (p && (p.y ?? p.speed)) || 0),
        borderColor: BRAND.primary,
        backgroundColor: 'rgba(255,107,53,0.12)',
        // tension 0 (no spline overshoot) so the drawn line never peaks above the
        // real max speed — avoids the trace visually exceeding the Top Speed stat.
        fill: true, tension: 0, pointRadius: 0, borderWidth: 1.6
      }]
    },
    options: {
      animation: false, devicePixelRatio: 2,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: {
          suggestedMax: Math.ceil(Math.max(0, ...speedData.map(p => (p && (p.y ?? p.speed)) || 0)) / 10) * 10,
          grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#666', font: { size: 16 }, maxTicksLimit: 6 }
        }
      }
    }
  };
  return (await chart.renderToDataURL(cfg)).replace(/^data:image\/png;base64,/, '');
}

async function renderGForceChart(visualizations, width = 1160, height = 280) {
  // Analyzer emits `gForceTrace` (capital F) with a single combined `.y` value.
  const gforceData = (visualizations && (visualizations.gForceTrace || visualizations.gforceTrace)) || [];
  if (!gforceData.length) return null;
  const chart = new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });
  const cfg = {
    type: 'line',
    data: {
      labels: gforceData.map((_, i) => i),
      datasets: [{
        label: 'G-Force',
        data: gforceData.map(p => (p && (p.y ?? p.g ?? 0)) || 0),
        borderColor: BRAND.accent,
        backgroundColor: 'rgba(0,212,170,0.12)',
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.8
      }]
    },
    options: {
      animation: false, devicePixelRatio: 2,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#666', font: { size: 16 }, maxTicksLimit: 5, callback: v => v + 'G' } }
      }
    }
  };
  return (await chart.renderToDataURL(cfg)).replace(/^data:image\/png;base64,/, '');
}

async function renderLapComparisonChart(laps, width = 1160, height = 300) {
  if (!laps || laps.length < 2) return null;
  const times = laps.map(lapTimeOf);
  const positive = times.filter(t => t > 0);
  if (!positive.length) return null;
  const bestT = Math.min(...positive);
  const chart = new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });
  const cfg = {
    type: 'bar',
    data: {
      labels: laps.map((l, i) => `Lap ${l.lapNumber || i + 1}`),
      datasets: [{
        label: 'Lap Time (s)',
        data: times.map(t => (t > 0 ? +t.toFixed(2) : null)),
        backgroundColor: times.map(t => (t > 0 && t === bestT) ? BRAND.accent : BRAND.primary + 'BB'),
        borderColor: BRAND.primary,
        borderWidth: 1, borderRadius: 4
      }]
    },
    options: {
      animation: false, devicePixelRatio: 2,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#666', font: { size: 15 } } },
        y: {
          // Zoom the y-axis to the lap-time band so differences are visible.
          min: Math.max(0, Math.floor(Math.min(...positive) - 2)),
          suggestedMax: Math.ceil(Math.max(...positive) + 1),
          grid: { color: 'rgba(0,0,0,0.06)' },
          ticks: { color: '#666', font: { size: 15 }, callback: v => v + 's' }
        }
      }
    }
  };
  return (await chart.renderToDataURL(cfg)).replace(/^data:image\/png;base64,/, '');
}

// ── Coaching safety / liability disclaimer (point-of-advice) ────────────────
export function drawCoachingDisclaimer(doc, y, C = BRAND) {
  const pageW = doc.page.width;
  const boxW = pageW - 2 * MARGIN;
  const pad = 10;
  const title = 'Safety & Liability Notice';
  const body =
    'AI coaching insights are automatically generated from your historical data and are ' +
    'general, informational observations only \u2014 not professional riding instruction or a ' +
    'recommendation to ride any particular way. They do not account for real-time conditions ' +
    '(track surface, weather, grip, traffic, tires, your fatigue or skill). A note such as ' +
    '\u201Cbrake later\u201D or \u201Ccarry more corner speed\u201D describes your data \u2014 it is NOT an ' +
    'instruction to do so on track. Do not change your riding unless you independently judge ' +
    'it safe and within your ability. Acting on any insight is entirely at your own risk. ' +
    'MotoTrackIQ is not liable for any injury, crash, or loss arising from reliance on these ' +
    'insights. For personalized, condition-aware coaching, consult a qualified instructor in person. ' +
    'Full terms: mototrackiq.com/terms.';

  doc.font('Helvetica', 8);
  const bodyH = doc.heightOfString(body, { width: boxW - pad * 2, lineGap: 1 });
  const boxH = bodyH + 34;

  if (y + boxH > doc.page.height - 50) { doc.addPage(); y = 50; }

  doc.save();
  doc.roundedRect(MARGIN, y, boxW, boxH, 4).fill('#fff5f2');
  doc.roundedRect(MARGIN, y, boxW, boxH, 4).lineWidth(1).stroke(C.danger || '#ff4757');
  doc.rect(MARGIN, y, 4, boxH).fill(C.danger || '#ff4757');
  doc.restore();

  doc.font('Helvetica-Bold', 9).fillColor(C.danger || '#ff4757')
     .text(title, MARGIN + pad, y + pad, { width: boxW - pad * 2 });
  doc.font('Helvetica', 8).fillColor('#555555')
     .text(body, MARGIN + pad, y + pad + 12, { width: boxW - pad * 2, lineGap: 1 });

  return y + boxH + 12;
}

// ── Section helpers ──────────────────────────────────────────────────────────

// Ensure there's room for `needed` pts below the cursor; add a page if not.
function ensureSpace(doc, y, needed) {
  if (y + needed > doc.page.height - 45) { doc.addPage(); return 50; }
  return y;
}

function sectionTitle(doc, y, text, C) {
  y = ensureSpace(doc, y, 30);
  doc.font('Helvetica-Bold', 12).fillColor(C.dark).text(text, MARGIN, y);
  const w = doc.widthOfString(text);
  doc.moveTo(MARGIN, y + 17).lineTo(MARGIN + Math.max(w, 60), y + 17).lineWidth(2).stroke(C.primary);
  return y + 26;
}

// Draw a chart image scaled to content width, returning the new y.
function drawChart(doc, y, b64, drawH, C) {
  const contentW = doc.page.width - 2 * MARGIN;
  y = ensureSpace(doc, y, drawH + 8);
  if (b64) {
    try { doc.image(Buffer.from(b64, 'base64'), MARGIN, y, { width: contentW, height: drawH }); }
    catch { doc.font('Helvetica', 9).fillColor(C.muted).text('Chart unavailable', MARGIN, y); }
  } else {
    doc.font('Helvetica', 9).fillColor(C.muted).text('Not enough data for this chart.', MARGIN, y);
  }
  return y + drawH + 12;
}

// ── PDF Builder ──────────────────────────────────────────────────────────────

export async function generateReport(analysisData, options = {}) {
  const { riderName = 'Rider', bikeName = '', outputPath = null } = options;
  const C = BRAND;
  const A = analysisData || {};
  const summary = A.summary || {};
  const metrics = A.metrics || {};
  const laps = A.laps || [];

  const doc = new PDFDocument({
    size: 'A4', margin: 0,
    info: {
      Title: `MotoTrackIQ Report — ${summary.trackName || 'Session'}`,
      Author: 'MotoTrackIQ', Subject: 'Track Day Analysis'
    }
  });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const pageW = doc.page.width;
  const contentW = pageW - 2 * MARGIN;

  // ── Header band ────────────────────────────────────────────────────────
  doc.rect(0, 0, pageW, 120).fill(C.dark);
  doc.rect(0, 0, 6, 120).fill(C.primary);
  doc.font('Helvetica-Bold', 26).fillColor(C.primary).text('MotoTrackIQ', MARGIN, 26, { lineBreak: false });
  doc.font('Helvetica', 11).fillColor(C.muted).text('Track Day Analytics', MARGIN, 54);

  // Top-right label + date — anchored with a left x and explicit width so it
  // right-aligns inside the content box instead of clipping off-page.
  const rLabelW = 260;
  doc.font('Helvetica', 9).fillColor(C.muted)
     .text('TRACK DAY ANALYSIS REPORT', pageW - MARGIN - rLabelW, 28, { width: rLabelW, align: 'right', lineBreak: false });
  const sessionDate = summary.sessionDate
    ? new Date(summary.sessionDate).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
    : new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.font('Helvetica', 10).fillColor(C.muted)
     .text(sessionDate, pageW - MARGIN - rLabelW, 44, { width: rLabelW, align: 'right', lineBreak: false });

  doc.moveTo(MARGIN, 88).lineTo(pageW - MARGIN, 88).lineWidth(1).stroke('#3a3a52');
  doc.font('Helvetica-Bold', 20).fillColor('#ffffff').text(summary.trackName || 'Unknown Track', MARGIN, 96, { lineBreak: false });
  doc.font('Helvetica', 10).fillColor(C.muted)
     .text([riderName, bikeName].filter(Boolean).join('  \u00b7  '), pageW - MARGIN - 260, 100, { width: 260, align: 'right', lineBreak: false });

  // ── Stats cards ──────────────────────────────────────────────────────────
  let y = 138;
  // Headline peak-G must not contradict the per-lap table. Prefer the true peak
  // from lap data (maxG / sector maxG); fall back to the summary metric.
  const lapPeakG = laps.reduce((mx, l) => {
    const cand = [lapGOf(l), ...((l.sectors || []).map(s => s.maxG || 0))];
    return Math.max(mx, ...cand);
  }, 0);
  const summaryPeakG = Math.max(metrics.maxGForces?.braking || 0, metrics.maxGForces?.cornering || 0, metrics.maxG || 0);
  const peakG = Math.max(lapPeakG, summaryPeakG);

  const stats = [
    { label: 'Laps', value: summary.lapCount || laps.length || 0, color: C.accent },
    { label: 'Best Lap', value: formatTime(A.lapStats?.best), color: C.primary },
    { label: 'Top Speed', value: `${Math.round(metrics.maxSpeed || 0)} km/h`, color: C.primary },
    { label: 'Avg Speed', value: `${Math.round(metrics.avgSpeed || 0)} km/h`, color: C.dark },
    { label: 'Peak G', value: `${peakG.toFixed(2)}G`, color: C.accent },
    { label: 'Consistency', value: consistencyLabel(A.lapStats), color: C.primary }
  ];
  const gap = 8;
  const cardW = (contentW - gap * (stats.length - 1)) / stats.length;
  const cardH = 52;
  stats.forEach((stat, i) => {
    const x = MARGIN + i * (cardW + gap);
    doc.roundedRect(x, y, cardW, cardH, 6).fill(C.light);
    doc.font('Helvetica-Bold', 15).fillColor(stat.color)
       .text(String(stat.value), x, y + 10, { width: cardW, align: 'center', lineBreak: false });
    doc.font('Helvetica', 7.5).fillColor('#777')
       .text(stat.label.toUpperCase(), x, y + 32, { width: cardW, align: 'center' });
  });
  y += cardH + 20;

  // ── Speed trace ────────────────────────────────────────────────────────
  y = sectionTitle(doc, y, 'SPEED TRACE', C);
  const speedImg = await renderSpeedTraceChart(A.visualizations);
  y = drawChart(doc, y, speedImg, 150, C);

  // ── Lap comparison chart ─────────────────────────────────────────────────
  if (laps.length >= 2) {
    y = sectionTitle(doc, y, 'LAP TIME COMPARISON', C);
    const lapImg = await renderLapComparisonChart(laps);
    y = drawChart(doc, y, lapImg, 140, C);
  }

  // ── Lap table (flows across pages) ───────────────────────────────────────
  if (laps.length > 0) {
    y = sectionTitle(doc, y, 'LAP TIMES', C);
    const cols = [MARGIN, MARGIN + 90, MARGIN + 210, MARGIN + 340, MARGIN + 440];
    const headers = ['Lap', 'Time', 'Top Speed', 'Max G', 'Delta to Best'];
    const drawHeader = (yy) => {
      doc.font('Helvetica-Bold', 8).fillColor('#888');
      headers.forEach((h, i) => doc.text(h, cols[i], yy, { width: 110, lineBreak: false }));
      doc.moveTo(MARGIN, yy + 13).lineTo(pageW - MARGIN, yy + 13).lineWidth(0.8).stroke('#dddddd');
      return yy + 20;
    };
    y = ensureSpace(doc, y, 40);
    y = drawHeader(y);

    const positive = laps.map(lapTimeOf).filter(t => t > 0);
    const bestT = positive.length ? Math.min(...positive) : 0;

    laps.forEach((lap, i) => {
      if (y > doc.page.height - 60) { doc.addPage(); y = 50; y = drawHeader(y); }
      const t = lapTimeOf(lap);
      const isBest = t > 0 && t === bestT;
      const delta = (bestT > 0 && t > 0 && !isBest) ? '+' + (t - bestT).toFixed(3) + 's' : (isBest ? 'BEST' : '—');
      // Zebra background for readability
      if (i % 2 === 1) { doc.rect(MARGIN, y - 3, contentW, 17).fill('#fafafa'); }
      doc.font(isBest ? 'Helvetica-Bold' : 'Helvetica', 9).fillColor(isBest ? C.accent : '#222222')
         .text(`Lap ${lap.lapNumber || i + 1}`, cols[0], y, { width: 110, lineBreak: false })
         .text(t > 0 ? formatTime(t) : '—', cols[1], y, { width: 110, lineBreak: false })
         .text(`${lapSpeedOf(lap)} km/h`, cols[2], y, { width: 110, lineBreak: false })
         .text(`${lapGOf(lap).toFixed(2)}G`, cols[3], y, { width: 110, lineBreak: false })
         .fillColor(isBest ? C.accent : (delta.startsWith('+') ? C.danger : '#222222'))
         .text(delta, cols[4], y, { width: 110, lineBreak: false });
      y += 17;
    });
    y += 12;
  }

  // ── G-Force trace ────────────────────────────────────────────────────────
  const gImg = await renderGForceChart(A.visualizations);
  if (gImg) {
    y = sectionTitle(doc, y, 'G-FORCE TRACE', C);
    y = drawChart(doc, y, gImg, 130, C);
  }

  // ── AI Coaching Notes ─────────────────────────────────────────────────────
  const coaching = A.coaching;
  if (coaching && Array.isArray(coaching.notes) && coaching.notes.length) {
    doc.addPage();
    doc.rect(0, 0, pageW, 84).fill(C.dark);
    doc.rect(0, 0, 6, 84).fill(C.primary);
    doc.font('Helvetica-Bold', 20).fillColor(C.primary).text('AI Coaching Notes', MARGIN, 28, { lineBreak: false });
    doc.font('Helvetica', 10).fillColor(C.muted).text('Data-driven observations from your session', MARGIN, 56);

    y = 110;
    if (coaching.summary) {
      doc.font('Helvetica-Oblique', 11).fillColor('#333333').text(pdfText(coaching.summary), MARGIN, y, { width: contentW });
      y = doc.y + 14;
    }
    coaching.notes.forEach(note => {
      const icon = pdfIcon(note.iconPdf || note.icon);
      const noteTitle = pdfText(note.title);
      const noteBody = pdfText(note.text);
      // Measure both blocks and keep the note together where possible.
      doc.font('Helvetica-Bold', 11);
      const titleH = doc.heightOfString(`${icon}  ${noteTitle}`, { width: contentW });
      doc.font('Helvetica', 10);
      const bodyH = doc.heightOfString(noteBody, { width: contentW, lineGap: 2 });
      if (y + titleH + bodyH + 20 > doc.page.height - 60) { doc.addPage(); y = 50; }
      doc.font('Helvetica-Bold', 11).fillColor(C.dark).text(`${icon}  ${noteTitle}`, MARGIN, y, { width: contentW });
      y = doc.y + 3;
      doc.font('Helvetica', 10).fillColor('#444444').text(noteBody, MARGIN, y, { width: contentW, lineGap: 2 });
      y = doc.y + 14;
    });
    y = drawCoachingDisclaimer(doc, y + 6, C);
  }

  // ── Footer on every page ──────────────────────────────────────────────────
  const range = doc.bufferedPageRange ? doc.bufferedPageRange() : { start: 0, count: 0 };
  // pdfkit paginates as we go; draw footer on the current final page at minimum.
  const footerY = doc.page.height - 28;
  doc.moveTo(MARGIN, footerY).lineTo(pageW - MARGIN, footerY).lineWidth(0.8).stroke('#e2e2e2');
  doc.font('Helvetica', 8).fillColor(C.muted)
     .text('Powered by MotoTrackIQ \u2014 AI Track Day Analytics', MARGIN, footerY + 8, { lineBreak: false })
     .text('mototrackiq.com', pageW - MARGIN - 120, footerY + 8, { width: 120, align: 'right', lineBreak: false });

  doc.end();
  return new Promise((resolve, reject) => {
    doc.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (outputPath) { fs.writeFileSync(outputPath, buf); resolve(outputPath); }
      else resolve(buf);
    });
    doc.on('error', reject);
  });
}

export default { generateReport, drawCoachingDisclaimer };
