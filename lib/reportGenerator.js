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
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, Image, registerFont } from 'canvas';
import fs from 'fs';
// __dirname equivalent for ES modules — resolves to /app/lib on Railway.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Register DejaVu Sans for chart axis labels.
// Prefer the bundled font in the same dir (guaranteed present, bypasses fontconfig).
// Falls back to system font path if bundle is missing.
const BUNDLED_FONT = path.join(__dirname, 'DejaVuSans.ttf');
const SYSTEM_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const fontPath = fs.existsSync(BUNDLED_FONT) ? BUNDLED_FONT : (fs.existsSync(SYSTEM_FONT) ? SYSTEM_FONT : null);
if (fontPath) { try { registerFont(fontPath, { family: 'DejaVu Sans' }); } catch (_) {} }

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


// ── SVG → PNG chart renderers (full control over axis labels) ───────────────


function svgToPNG(svgString, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.src = Buffer.from(svgString);
  try { ctx.drawImage(img, 0, 0, width, height); } catch (_) {}
  return canvas.toBuffer('image/png').toString('base64');
}


function buildSpeedSVG(speedData, lapInfo, width, height) {
  // Chart geometry
  const ML = 72, MR = 24, MT = 24, MB = 64;
  const cW = width - ML - MR, cH = height - MT - MB;
  const cX = ML, cY = MT;

  // Compute lap-boundary indices using totalPoints + laps[] timing
  const numLaps = lapInfo.laps?.length ?? 1;
  const totalTime = lapInfo.laps?.reduce((s, l) => s + (l.time ?? 0), 0) ?? 1;
  const lapBoundaries = [0];
  let cumulativeTime = 0;
  for (const lt of (lapInfo.laps ?? [])) {
    cumulativeTime += (lt.time ?? 0);
    lapBoundaries.push(Math.round((cumulativeTime / totalTime) * (speedData.length - 1)));
  }
  lapBoundaries.push(speedData.length - 1); // ensure last point is covered

  // Y range
  const maxY = Math.ceil(Math.max(0, ...speedData.map(p => (p && (p.y ?? p.speed)) || 0)) / 10) * 10;
  const minY = 0;
  const yRange = maxY - minY || 1;
  const xRange = speedData.length - 1 || 1;

  const d2p = (xi, yv) => ({
    x: cX + (xi / xRange) * cW,
    y: cY + cH - ((yv - minY) / yRange) * cH
  });

  // Build SVG path for speed area
  const pts = speedData.map((p, i) => d2p(i, (p && (p.y ?? p.speed)) || 0));
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (const p of pts) d += ` L ${p.x},${p.y}`;
  const last = pts[pts.length - 1];
  d += ` L ${last.x},${cY + cH} L ${pts[0].x},${cY + cH} Z`;

  // Y-axis ticks (6 ticks)
  const yTicks = Array.from({ length: 6 }, (_, i) => Math.round((maxY / 5) * i));

  // X-axis tick positions: one per lap at the lap start
  const xTicks = [];
  for (let lap = 0; lap < numLaps; lap++) {
    const xi = lapBoundaries[lap] ?? 0;
    xTicks.push({ xi, label: `Lap ${lap + 1}` });
  }

  // Vertical dashed lines at lap boundaries (not for lap 0)
  const lapLines = [];
  for (let lap = 1; lap < numLaps; lap++) {
    const xi = lapBoundaries[lap] ?? 0;
    const px = cX + (xi / xRange) * cW;
    if (px > cX && px < cX + cW) lapLines.push(px);
  }

  const xmlns = 'http://www.w3.org/2000/svg';
  let svg = `<svg xmlns="${xmlns}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += `<rect width="${width}" height="${height}" fill="white"/>`;

  // Clip to chart area
  svg += `<clipPath id="ca"><rect x="${cX}" y="${cY}" width="${cW}" height="${cH}"/></clipPath>`;

  // Grid lines (horizontal)
  for (const yt of yTicks) {
    const py = cY + cH - ((yt - minY) / yRange) * cH;
    svg += `<line x1="${cX}" y1="${py}" x2="${cX + cW}" y2="${py}" stroke="rgba(0,0,0,0.08)" stroke-width="1"/>`;
  }

  // Lap-boundary vertical dashed lines
  for (const px of lapLines) {
    svg += `<line x1="${px}" y1="${cY}" x2="${px}" y2="${cY + cH}" stroke="rgba(0,0,0,0.2)" stroke-width="1.5" stroke-dasharray="5,4"/>`;
  }

  // Area fill
  svg += `<path d="${d}" fill="rgba(255,107,53,0.12)" clip-path="url(#ca)"/>`;
  // Line
  svg += `<path d="${d}" fill="none" stroke="#ff6b35" stroke-width="1.6" stroke-linejoin="round" clip-path="url(#ca)"/>`;

  // Y-axis
  svg += `<line x1="${cX}" y1="${cY}" x2="${cX}" y2="${cY + cH}" stroke="rgba(0,0,0,0.15)" stroke-width="1"/>`;
  for (const yt of yTicks) {
    const py = cY + cH - ((yt - minY) / yRange) * cH;
    svg += `<line x1="${cX - 6}" y1="${py}" x2="${cX}" y2="${py}" stroke="#444" stroke-width="1"/>`;
    svg += `<text x="${cX - 10}" y="${py + 5}" text-anchor="end" fill="#444" font-size="18" font-weight="bold" font-family="DejaVu Sans, Arial">${yt}</text>`;
  }
  // Y-axis title
  svg += `<text x="${20}" y="${cY + cH / 2}" text-anchor="middle" fill="#333" font-size="20" font-weight="bold" font-family="DejaVu Sans, Arial" transform="rotate(-90,20,${cY + cH/2})">Speed (km/h)</text>`;

  // X-axis
  svg += `<line x1="${cX}" y1="${cY + cH}" x2="${cX + cW}" y2="${cY + cH}" stroke="rgba(0,0,0,0.15)" stroke-width="1"/>`;
  for (const xt of xTicks) {
    const px = cX + (xt.xi / xRange) * cW;
    svg += `<line x1="${px}" y1="${cY + cH}" x2="${px}" y2="${cY + cH + 8}" stroke="#444" stroke-width="1"/>`;
    svg += `<text x="${px}" y="${cY + cH + 28}" text-anchor="${xt.xi === 0 ? 'start' : 'middle'}" fill="#444" font-size="16" font-weight="bold" font-family="DejaVu Sans, Arial">${xt.label}</text>`;
  }
  svg += `<text x="${cX + cW / 2}" y="${height - 8}" text-anchor="middle" fill="#333" font-size="18" font-weight="bold" font-family="DejaVu Sans, Arial">Lap</text>`;

  svg += `</svg>`;
  return svg;
}

function buildGForceSVG(gforceData, lapInfo, width, height) {
  const ML = 72, MR = 24, MT = 24, MB = 64;
  const cW = width - ML - MR, cH = height - MT - MB;
  const cX = ML, cY = MT;

  const numLaps = lapInfo.laps?.length ?? 1;
  const totalTime = lapInfo.laps?.reduce((s, l) => s + (l.time ?? 0), 0) ?? 1;
  const lapBoundaries = [0];
  let cumulativeTime = 0;
  for (const lt of (lapInfo.laps ?? [])) {
    cumulativeTime += (lt.time ?? 0);
    lapBoundaries.push(Math.round((cumulativeTime / totalTime) * (gforceData.length - 1)));
  }
  lapBoundaries.push(gforceData.length - 1);

  const maxY = Math.ceil(Math.max(0, ...gforceData.map(p => (p && (p.y ?? p.g ?? 0)) || 0)));
  const minY = 0;
  const yRange = maxY - minY || 1;
  const xRange = gforceData.length - 1 || 1;

  const d2p = (xi, yv) => ({
    x: cX + (xi / xRange) * cW,
    y: cY + cH - ((yv - minY) / yRange) * cH
  });

  const pts = gforceData.map((p, i) => d2p(i, (p && (p.y ?? p.g ?? 0)) || 0));
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (const p of pts) d += ` L ${p.x},${p.y}`;
  const last = pts[pts.length - 1];
  d += ` L ${last.x},${cY + cH} L ${pts[0].x},${cY + cH} Z`;

  const yTicks = [0, 0.5, 1, 1.5, 2, 2.5, 3].filter(v => v <= maxY + 0.5);

  const xTicks = [];
  for (let lap = 0; lap < numLaps; lap++) {
    xTicks.push({ xi: lapBoundaries[lap] ?? 0, label: `Lap ${lap + 1}` });
  }

  const lapLines = [];
  for (let lap = 1; lap < numLaps; lap++) {
    const px = cX + ((lapBoundaries[lap] ?? 0) / xRange) * cW;
    if (px > cX && px < cX + cW) lapLines.push(px);
  }

  const xmlns = 'http://www.w3.org/2000/svg';
  let svg = `<svg xmlns="${xmlns}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += `<rect width="${width}" height="${height}" fill="white"/>`;
  svg += `<clipPath id="gca"><rect x="${cX}" y="${cY}" width="${cW}" height="${cH}"/></clipPath>`;

  for (const yt of yTicks) {
    const py = cY + cH - ((yt - minY) / yRange) * cH;
    svg += `<line x1="${cX}" y1="${py}" x2="${cX + cW}" y2="${py}" stroke="rgba(0,0,0,0.08)" stroke-width="1"/>`;
  }
  for (const px of lapLines) {
    svg += `<line x1="${px}" y1="${cY}" x2="${px}" y2="${cY + cH}" stroke="rgba(0,0,0,0.2)" stroke-width="1.5" stroke-dasharray="5,4"/>`;
  }

  svg += `<path d="${d}" fill="rgba(0,212,170,0.12)" clip-path="url(#gca)"/>`;
  svg += `<path d="${d}" fill="none" stroke="#00d4aa" stroke-width="1.8" stroke-linejoin="round" clip-path="url(#gca)"/>`;

  svg += `<line x1="${cX}" y1="${cY}" x2="${cX}" y2="${cY + cH}" stroke="rgba(0,0,0,0.15)" stroke-width="1"/>`;
  for (const yt of yTicks) {
    const py = cY + cH - ((yt - minY) / yRange) * cH;
    svg += `<line x1="${cX - 6}" y1="${py}" x2="${cX}" y2="${py}" stroke="#444" stroke-width="1"/>`;
    svg += `<text x="${cX - 10}" y="${py + 5}" text-anchor="end" fill="#444" font-size="18" font-weight="bold" font-family="DejaVu Sans, Arial">${yt}G</text>`;
  }
  svg += `<text x="${20}" y="${cY + cH / 2}" text-anchor="middle" fill="#333" font-size="20" font-weight="bold" font-family="DejaVu Sans, Arial" transform="rotate(-90,20,${cY + cH/2})">G-Force</text>`;

  svg += `<line x1="${cX}" y1="${cY + cH}" x2="${cX + cW}" y2="${cY + cH}" stroke="rgba(0,0,0,0.15)" stroke-width="1"/>`;
  for (const xt of xTicks) {
    const px = cX + (xt.xi / xRange) * cW;
    svg += `<line x1="${px}" y1="${cY + cH}" x2="${px}" y2="${cY + cH + 8}" stroke="#444" stroke-width="1"/>`;
    svg += `<text x="${px}" y="${cY + cH + 28}" text-anchor="${xt.xi === 0 ? 'start' : 'middle'}" fill="#444" font-size="16" font-weight="bold" font-family="DejaVu Sans, Arial">${xt.label}</text>`;
  }
  svg += `<text x="${cX + cW / 2}" y="${height - 8}" text-anchor="middle" fill="#333" font-size="18" font-weight="bold" font-family="DejaVu Sans, Arial">Lap</text>`;

  svg += `</svg>`;
  return svg;
}

// ── Backwards-compatible wrappers (still used internally) ────────────────────

async function renderSpeedTraceChart(visualizations, lapInfo, width = 1160, height = 320) {
  const speedData = (visualizations && visualizations.speedTrace) || [];
  if (!speedData.length) return null;
  const svg = buildSpeedSVG(speedData, lapInfo, width, height);
  return svgToPNG(svg, width, height);
}

async function renderGForceChart(visualizations, lapInfo, width = 1160, height = 280) {
  const gforceData = (visualizations && (visualizations.gForceTrace || visualizations.gforceTrace)) || [];
  if (!gforceData.length) return null;
  const svg = buildGForceSVG(gforceData, lapInfo, width, height);
  return svgToPNG(svg, width, height);
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
        x: { grid: { display: false }, ticks: { color: '#444', font: { size: 16, weight: 'bold', family: 'sans-serif' } } },
        y: {
          // Zoom the y-axis to the lap-time band so differences are visible.
          min: Math.max(0, Math.floor(Math.min(...positive) - 2)),
          suggestedMax: Math.ceil(Math.max(...positive) + 1),
          grid: { color: 'rgba(0,0,0,0.06)' },
          ticks: { color: '#444', font: { size: 16, weight: 'bold', family: 'sans-serif' }, callback: v => v + 's' },
          title: { display: true, text: 'Lap Time (s)', color: '#333', font: { size: 18, weight: 'bold' }, padding: { bottom: 8 } }
        }
      }
    }
  };
  return (await chart.renderToDataURL(cfg)).replace(/^data:image\/png;base64,/, '');
}

// Speed color ramp: cool blue (slow) -> green -> yellow -> orange -> red (fast).
// Returns an [r,g,b] triple; callers format for Chart.js (rgb()) or PDFKit (hex).
function speedRGB(t) {
  const stops = [
    [0.0, [37, 99, 235]],   // blue
    [0.35, [16, 185, 129]], // green
    [0.6, [234, 179, 8]],   // yellow
    [0.8, [249, 115, 22]],  // orange
    [1.0, [239, 68, 68]]    // red
  ];
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const f = (t - t0) / ((t1 - t0) || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f)
      ];
    }
  }
  return [239, 68, 68];
}
function speedColor(t) { const [r, g, b] = speedRGB(t); return `rgb(${r},${g},${b})`; }
function speedHex(t) {
  const [r, g, b] = speedRGB(t);
  const h = n => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Render the GPS track map as a speed-colored racing line with sector markers.
// Sector boundaries (S2 start, S3 start) are drawn as annotated point markers.
export async function renderTrackMap(visualizations, width = 900, height = 900) {
  const map = visualizations && visualizations.trackMap;
  if (!map || !Array.isArray(map.path) || map.path.length < 10) return null;
  const p = map.path;
  const sectorMarkers = map.sectorMarkers || [];

  const chart = new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });

  // Build datasets: racing line + sector boundary markers
  const datasets = [{
    data: p.map(q => ({ x: q.x, y: q.y })),
    parsing: false,
    borderColor: BRAND.primary,
    borderWidth: 5,
    pointRadius: 0,
    tension: 0,
    fill: false,
    showLine: true,
    segment: {
      borderColor: (ctx) => {
        const i = ctx.p1DataIndex != null ? ctx.p1DataIndex : ctx.p0DataIndex;
        const t = (p[i] && p[i].t != null) ? p[i].t : 0.5;
        return speedColor(t);
      }
    }
  }];

  // Add sector boundary markers
  if (sectorMarkers.length > 0) {
    datasets.push({
      data: sectorMarkers.map(m => ({ x: m.point.x, y: m.point.y, sector: m.sector })),
      parsing: false,
      borderColor: 'transparent',
      backgroundColor: BRAND.accent,
      pointRadius: 14,
      pointStyle: 'triangle',
      rotation: (ctx) => {
        // Rotate triangle to point along track direction at sector boundary
        const idx = ctx.dataIndex;
        const sector = sectorMarkers[idx]?.sector;
        return sector === 2 ? 90 : 180; // S2 marker rotated to point right, S3 to point down
      },
      showLine: false
    });
    // Labels for S2 and S3
    datasets.push({
      data: sectorMarkers.map(m => ({ x: m.point.x, y: m.point.y })),
      parsing: false,
      borderColor: 'transparent',
      backgroundColor: 'transparent',
      pointRadius: 0,
      showLine: false,
      label: 'Sector Labels'
    });
  }

  const cfg = {
    type: 'line',
    data: { datasets },
    options: {
      animation: false, devicePixelRatio: 2,
      parsing: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          callbacks: {
            title: (items) => {
              const idx = items[0]?.dataIndex;
              const m = sectorMarkers.find(sm =>
                sm.point.x === p[idx]?.x && sm.point.y === p[idx]?.y
              );
              return m ? `Sector ${m.sector} start` : '';
            }
          }
        },
        // Draw sector labels directly on the canvas
        afterDraw: (chart) => {
          if (!sectorMarkers.length) return;
          const ctx = chart.ctx;
          ctx.save();
          sectorMarkers.forEach(m => {
            const { x, y } = chart.scales.x.getPixelForValue(m.point.x);
            const yPx = chart.scales.y.getPixelForValue(m.point.y);
            // Draw "S2" or "S3" label with a background pill
            const label = `S${m.sector}`;
            ctx.font = 'bold 22px sans-serif';
            const tw = ctx.measureText(label).width;
            const px = x - tw / 2;
            const py = yPx - 30;
            ctx.fillStyle = 'rgba(0,212,170,0.85)';
            ctx.beginPath();
            ctx.roundRect(px - 8, py - 18, tw + 16, 28, 6);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.fillText(label, px, py);
            // Draw the sector line perpendicular to track direction
            ctx.strokeStyle = 'rgba(0,212,170,0.5)';
            ctx.lineWidth = 3;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(x - 20, yPx);
            ctx.lineTo(x + 20, yPx);
            ctx.stroke();
          });
          ctx.restore();
        }
      },
      scales: {
        x: { type: 'linear', display: false, min: -20, max: 1020 },
        y: { type: 'linear', display: false, min: -20, max: 1020 }
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
    'Full terms: mototrackiq.com/terms. Note: Cornering G-force values may be ' +
    'influenced by sensor placement and body position \u2014 treat cornering data as directional ' +
    'indicators only, not absolute measurements.';

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
// Footer is drawn on each page when we detect no more content will fit (i.e., right
// before addPage() is called). This ensures the footer is drawn on a blank footer zone,
// then new page starts fresh with header.
function ensureSpace(doc, y, needed) {
  if (y + needed > doc.page.height - 45) {
    drawFooter(doc);
    doc.addPage();
    return 50;
  }
  return y;
}

// Draw footer at the bottom of the current page.
function drawFooter(doc) {
  const footerY = doc.page.height - 30;
  doc.moveTo(MARGIN, footerY).lineTo(doc.page.width - MARGIN, footerY).lineWidth(0.8).stroke('#e2e2e2');
  const footerLine = 'MotoTrackIQ  \u00b7  Track smarter. Go faster.  \u00b7  mototrackiq.com';
  doc.font('Helvetica', 9).fillColor('#666')
     .text(footerLine, MARGIN, footerY + 8, { width: doc.page.width - 2 * MARGIN, align: 'center' });
}

function sectionTitle(doc, y, text, C) {
  y = ensureSpace(doc, y, 30);
  doc.font('Helvetica-Bold', 12).fillColor(C.dark).text(text, MARGIN, y);
  const w = doc.widthOfString(text);
  doc.moveTo(MARGIN, y + 17).lineTo(MARGIN + Math.max(w, 60), y + 17).lineWidth(2).stroke(C.primary);
  return y + 26;
}

// Draw a chart section (title + chart) together to prevent page-split.
// Pass sectionTitle=null to skip the title (for track map which has its own title).
function drawChartSection(doc, y, b64, drawH, sectionTitleText, C) {
  const contentW = doc.page.width - 2 * MARGIN;
  const titleH = sectionTitleText ? 30 : 0;
  y = ensureSpace(doc, y, drawH + titleH + 8);
  if (sectionTitleText) {
    doc.font('Helvetica-Bold', 12).fillColor(C.dark).text(sectionTitleText, MARGIN, y);
    const w = doc.widthOfString(sectionTitleText);
    doc.moveTo(MARGIN, y + 17).lineTo(MARGIN + Math.max(w, 60), y + 17).lineWidth(2).stroke(C.primary);
    y += 26;
  }
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
  try {
    const logoPath = path.join(__dirname, 'mototrackiq-logo.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, MARGIN, 12, { width: 160, height: 50 });
      doc.font('Helvetica-Bold', 26).fillColor(C.primary).text('MotoTrackIQ', MARGIN + 172, 26, { lineBreak: false });
      doc.font('Helvetica', 11).fillColor(C.muted).text('Track Day Analytics', MARGIN + 172, 54);
    } else {
      doc.font('Helvetica-Bold', 26).fillColor(C.primary).text('MotoTrackIQ', MARGIN, 26, { lineBreak: false });
      doc.font('Helvetica', 11).fillColor(C.muted).text('Track Day Analytics', MARGIN, 54);
    }
  } catch(e) {
    doc.font('Helvetica-Bold', 26).fillColor(C.primary).text('MotoTrackIQ', MARGIN, 26, { lineBreak: false });
    doc.font('Helvetica', 11).fillColor(C.muted).text('Track Day Analytics', MARGIN, 54);
  }

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

  // ── Track map (speed-colored racing line from GPS) ──────────────────────
  const mapImg = await renderTrackMap(A.visualizations);
  if (mapImg) {
    const tm = A.visualizations.trackMap;
    y = sectionTitle(doc, y, 'TRACK MAP \u00b7 SPEED HEAT', C);
    const mapSize = 230;
    y = ensureSpace(doc, y, mapSize + 10);
    const mapX = MARGIN;
    try { doc.image(Buffer.from(mapImg, 'base64'), mapX, y, { width: mapSize, height: mapSize }); }
    catch { /* skip on decode error */ }

    const legX = mapX + mapSize + 24;
    const legW = contentW - mapSize - 24;
    let ly = y + 6;
    doc.font('Helvetica-Bold', 10).fillColor(C.dark)
       .text('Racing line, colored by speed', legX, ly, { width: legW }); ly += 18;
    doc.font('Helvetica', 8.5).fillColor('#555')
       .text(tm.scope === 'bestLap'
         ? 'Your fastest lap\u2019s GPS path. Cooler = slower (braking / apex), hotter = faster (drive / straights).'
         : 'Session GPS path. Cooler = slower (braking / apex), hotter = faster (drive / straights).',
         legX, ly, { width: legW }); ly += 34;

    const rampW = Math.min(legW, 200), rampH = 12, steps = 40;
    doc.save();
    for (let i = 0; i < steps; i++) {
      const x0 = legX + (rampW / steps) * i;
      doc.rect(x0, ly, (rampW / steps) + 0.8, rampH).fill(speedHex(i / (steps - 1)));
    }
    doc.restore();
    doc.fillColor('#000000');
    doc.font('Helvetica', 7.5).fillColor('#777')
       .text(`${tm.speedRange.min} km/h`, legX, ly + rampH + 3, { width: rampW / 2, lineBreak: false })
       .text(`${tm.speedRange.max} km/h`, legX + rampW / 2, ly + rampH + 3, { width: rampW / 2, align: 'right', lineBreak: false });
    ly += rampH + 22;
    doc.font('Helvetica-Oblique', 7.5).fillColor('#999')
       .text('GPS-derived. Small position drift is normal; use for line/speed trends, not survey accuracy.', legX, ly, { width: legW });

    y += mapSize + 16;
  }

  // ── Speed trace ────────────────────────────────────────────────────────
  const speedImg = await renderSpeedTraceChart(A.visualizations, { totalPoints: A.summary.totalPoints, laps: A.laps });
  y = drawChartSection(doc, y, speedImg, 150, 'SPEED TRACE', C);

  // ── Lap comparison chart ─────────────────────────────────────────────────
  if (laps.length >= 2) {
    const lapImg = await renderLapComparisonChart(laps);
    y = drawChartSection(doc, y, lapImg, 140, 'LAP TIME COMPARISON', C);
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
  const gImg = await renderGForceChart(A.visualizations, { totalPoints: A.summary.totalPoints, laps: A.laps });
  if (gImg) {
    y = drawChartSection(doc, y, gImg, 130, 'G-FORCE TRACE', C);
  }

  // Draw footer + new page header for coaching section
  drawFooter(doc);
  doc.addPage();
  // Coaching page header
  doc.rect(0, 0, doc.page.width, 84).fill(C.dark);
  doc.rect(0, 0, 6, 84).fill(C.primary);
  doc.font('Helvetica-Bold', 20).fillColor(C.primary).text('AI Coaching Notes', MARGIN, 28, { lineBreak: false });
  doc.font('Helvetica', 10).fillColor(C.muted).text('Data-driven observations from your session', MARGIN, 56);

  // ── AI Coaching Notes ─────────────────────────────────────────────────────
  const coaching = A.coaching;
  if (coaching && Array.isArray(coaching.notes) && coaching.notes.length) {
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
  // pdfkit paginates as we go; draw footer on every page using a function.
  // Draw header band (logo + brand + date) and footer on every page.
  // We hook into PDFKit's 'page' event which fires AFTER each page is initialized
  // (including intermediate pages created by content overflow).
  // To ensure the first page also gets a header/footer, we also call it immediately
  // after all content is written — but since content comes AFTER the header band in
  // generateReport, we handle it differently: draw header BEFORE content, footer via event.


  // Ensure final footer appears after all content
  drawFooter(doc);
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

export default { generateReport, drawCoachingDisclaimer, renderTrackMap };
