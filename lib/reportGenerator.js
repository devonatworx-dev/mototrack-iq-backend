/**
 * MotoTrackIQ - PDF Report Generator
 * Takes analysis result → professional shareable PDF
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

// ── Chart renderers ─────────────────────────────────────────────────────────

async function renderSpeedTraceChart(visualization, width = 580, height = 160) {
  const chart = new ChartJSNodeCanvas({ width, height });
  const speedData = visualization.speedTrace || [];

  const cfg = {
    type: 'line',
    data: {
      labels: speedData.map((_, i) => i),
      datasets: [{
        label: 'Speed (km/h)',
        data: speedData.map(p => p.y),
        borderColor: BRAND.primary,
        backgroundColor: 'rgba(255,107,53,0.12)',
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2
      }]
    },
    options: {
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: {
          grid: { color: 'rgba(255,255,255,0.07)' },
          ticks: { color: '#888', font: { size: 9 }, maxTicksLimit: 5 }
        }
      }
    }
  };

  const dataUrl = await chart.renderToDataURL(cfg);
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}


async function renderGForceChart(visualization, width = 580, height = 140) {
  const chart = new ChartJSNodeCanvas({ width, height });
  const gforceData = visualization.gforceTrace || [];

  if (!gforceData || gforceData.length === 0) return null;

  const cfg = {
    type: 'line',
    data: {
      labels: gforceData.map((_, i) => i),
      datasets: [
        {
          label: 'Braking G',
          data: gforceData.map(p => p.braking || 0),
          borderColor: BRAND.danger,
          backgroundColor: 'transparent',
          tension: 0.3, pointRadius: 0, borderWidth: 1.5
        },
        {
          label: 'Cornering G',
          data: gforceData.map(p => p.cornering || 0),
          borderColor: BRAND.accent,
          backgroundColor: 'transparent',
          tension: 0.3, pointRadius: 0, borderWidth: 1.5
        }
      ]
    },
    options: {
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: {
          grid: { color: 'rgba(255,255,255,0.07)' },
          ticks: { color: '#888', font: { size: 9 }, maxTicksLimit: 4 }
        }
      }
    }
  };

  const dataUrl = await chart.renderToDataURL(cfg);
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}

// ── Lap comparison chart ────────────────────────────────────────────────────

async function renderLapComparisonChart(laps, width = 580, height = 140) {
  if (!laps || laps.length < 2) return null;

  const chart = new ChartJSNodeCanvas({ width, height });
  const cfg = {
    type: 'bar',
    data: {
      labels: laps.map((l, i) => `Lap ${i + 1}`),
      datasets: [{
        label: 'Lap Time (s)',
        data: laps.map(l => l.lapTime),
        backgroundColor: laps.map((l, i) =>
          i === laps.findIndex(bl => bl.lapTime === Math.min(...laps.map(x => x.lapTime)))
            ? BRAND.accent : BRAND.primary + '99'
        ),
        borderColor: BRAND.primary,
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#aaa' } },
        y: {
          grid: { color: 'rgba(255,255,255,0.07)' },
          ticks: { color: '#888', callback: v => v + 's' }
        }
      }
    }
  };

  const dataUrl = await chart.renderToDataURL(cfg);
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}

// ── PDF Builder ─────────────────────────────────────────────────────────────

export async function generateReport(analysisData, options = {}) {
  const {
    riderName = 'Rider',
    bikeName = '',
    outputPath = null  // if null, returns Buffer
  } = options;

  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: {
      Title: `MotoTrackIQ Report — ${analysisData.summary.trackName}`,
      Author: 'MotoTrackIQ',
      Subject: 'Track Day Analysis'
    }
  });

  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));

  // Colors
  const C = BRAND;

  // ── PAGE 1: Summary ─────────────────────────────────────────────────────
  // Dark header band
  doc.rect(0, 0, doc.page.width, 120).fill(C.dark);

  // Brand mark — orange accent line
  doc.rect(0, 0, 6, 120).fill(C.primary);

  // Logo text
  doc.font('Helvetica-Bold', 28)
     .fillColor(C.primary)
     .text('MotoTrackIQ', 40, 28, { lineBreak: false });

  doc.font('Helvetica', 12)
     .fillColor(C.muted)
     .text('Track Day Analytics', 40, 56);

  // Report label top-right
  doc.font('Helvetica', 9)
     .fillColor(C.muted)
     .text('TRACK DAY ANALYSIS REPORT', doc.page.width - 40, 28, {
       align: 'right', lineBreak: false
     });

  // Session date
  const sessionDate = analysisData.summary.sessionDate
    ? new Date(analysisData.summary.sessionDate).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
    : new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.font('Helvetica', 10)
     .fillColor(C.muted)
     .text(sessionDate, doc.page.width - 40, 46, { align: 'right' });

  // Separator
  doc.moveTo(40, 90).lineTo(doc.page.width - 40, 90).stroke(C.muted + '44');

  // Track name large
  doc.font('Helvetica-Bold', 22)
     .fillColor('#ffffff')
     .text(analysisData.summary.trackName || 'Unknown Track', 40, 100);

  // Rider + bike info
  doc.font('Helvetica', 10)
     .fillColor(C.muted)
     .text([riderName, bikeName].filter(Boolean).join(' · '), 40, 126);

  // ── Stats row ──────────────────────────────────────────────────────────
  const statsY = 155;
  const stats = [
    { label: 'Laps', value: analysisData.summary.lapCount || 0, color: C.accent },
    { label: 'Best Lap', value: formatTime(analysisData.lapStats?.best), color: C.primary },
    { label: 'Top Speed', value: `${Math.round(analysisData.metrics?.maxSpeed || 0)} km/h`, color: C.primary },
    { label: 'Avg Speed', value: `${Math.round(analysisData.metrics?.avgSpeed || 0)} km/h`, color: C.muted },
    { label: 'Max Braking', value: `${(analysisData.metrics?.maxGForces?.braking || 0).toFixed(1)}G`, color: C.danger },
    { label: 'Max Cornering', value: `${(analysisData.metrics?.maxGForces?.cornering || 0).toFixed(1)}G`, color: C.accent }
  ];

  const statW = (doc.page.width - 80) / stats.length;
  stats.forEach((stat, i) => {
    const x = 40 + i * statW;
    doc.font('Helvetica-Bold', 20).fillColor(stat.color)
       .text(String(stat.value), x, statsY, { width: statW, align: 'center', lineBreak: false });
    doc.font('Helvetica', 8).fillColor(C.muted)
       .text(stat.label, x, statsY + 24, { width: statW, align: 'center' });
  });

  // Divider
  doc.moveTo(40, statsY + 40).lineTo(doc.page.width - 40, statsY + 40).stroke(C.muted + '33');

  // ── Speed trace chart ──────────────────────────────────────────────────
  const chartY = statsY + 52;

  doc.font('Helvetica-Bold', 11).fillColor('#ffffff')
     .text('SPEED TRACE', 40, chartY);

  doc.font('Helvetica', 8).fillColor(C.muted)
     .text('km/h', doc.page.width - 60, chartY + 1);

  try {
    const speedChartImg = await renderSpeedTraceChart(analysisData.visualizations);
    doc.image(Buffer.from(speedChartImg, 'base64'), 40, chartY + 14, { width: doc.page.width - 80 });
  } catch (e) {
    doc.font('Helvetica', 9).fillColor(C.muted)
       .text('Chart unavailable', 40, chartY + 14);
  }

  // ── Lap table ─────────────────────────────────────────────────────────
  const lapTableY = chartY + 14 + 160 + 20;
  const laps = analysisData.laps || [];

  if (laps.length > 0) {
    doc.font('Helvetica-Bold', 11).fillColor('#ffffff')
       .text('LAP TIMES', 40, lapTableY);

    if (laps.length >= 2) {
      try {
        const lapChartImg = await renderLapComparisonChart(laps);
        if (lapChartImg) {
          doc.image(Buffer.from(lapChartImg, 'base64'), 40, lapTableY + 18, { width: doc.page.width - 80 });
        }
      } catch (e) { /* chart optional */ }
    }

    const tableTop = lapTableY + (laps.length >= 2 ? 165 : 22);
    const cols = [40, 150, 260, 370, 480];
    const headers = ['Lap', 'Time', 'Top Speed', 'Braking G', 'Cornering G'];

    // Header
    doc.font('Helvetica-Bold', 8).fillColor(C.muted);
    headers.forEach((h, i) => doc.text(h, cols[i], tableTop, { width: 100 }));

    doc.moveTo(40, tableTop + 14).lineTo(doc.page.width - 40, tableTop + 14).stroke(C.muted + '33');

    // Rows
    const bestIdx = laps.findIndex(l => l.lapTime === Math.min(...laps.map(x => x.lapTime)));
    laps.forEach((lap, i) => {
      const rowY = tableTop + 20 + i * 18;
      const isBest = i === bestIdx;
      doc.font('Helvetica', 9).fillColor(isBest ? C.accent : '#ffffff')
         .text(`Lap ${i + 1}`, cols[0], rowY, { width: 100 })
         .text(formatTime(lap.lapTime), cols[1], rowY, { width: 100 })
         .text(`${Math.round(lap.topSpeed || 0)} km/h`, cols[2], rowY, { width: 100 })
         .text(`${(lap.maxBraking || 0).toFixed(1)}G`, cols[3], rowY, { width: 100 })
         .text(`${(lap.maxCornering || 0).toFixed(1)}G`, cols[4], rowY, { width: 100 });
    });
  }

  // ── G-Force section ───────────────────────────────────────────────────
  if (analysisData.visualizations?.gforceTrace?.length > 0) {
    const gfY = doc.page.height - 260;

    doc.font('Helvetica-Bold', 11).fillColor('#ffffff')
       .text('G-FORCE DATA', 40, gfY);

    try {
      const gChartImg = await renderGForceChart(analysisData.visualizations);
      if (gChartImg) {
        doc.image(Buffer.from(gChartImg, 'base64'), 40, gfY + 18, { width: doc.page.width - 80 });
      }
    } catch (e) { /* optional */ }
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  const footerY = doc.page.height - 30;
  doc.moveTo(40, footerY).lineTo(doc.page.width - 40, footerY).stroke(C.muted + '22');
  doc.font('Helvetica', 8).fillColor(C.muted)
     .text('Powered by MotoTrackIQ — AI Track Day Analytics', 40, footerY + 8)
     .text('momotrackiq.com', doc.page.width - 120, footerY + 8);

  // ── Finalize ───────────────────────────────────────────────────────────
  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (outputPath) {
        fs.writeFileSync(outputPath, buf);
        resolve(outputPath);
      } else {
        resolve(buf);
      }
    });
    doc.on('error', reject);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTime(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(3);
  return m > 0 ? `${m}:${String(s).padStart(6, '0')}` : `${s}s`;
}

export default { generateReport };
