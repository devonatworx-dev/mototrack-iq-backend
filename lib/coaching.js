'use strict';

// Generate rule-based "AI coaching" insights from an analyzeCSV() result.
// Returns { summary, notes[] } where notes are short, actionable observations.
// Deterministic + data-driven so it works with zero external API cost.

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(3);
  return m > 0 ? `${m}:${String(s).padStart(6, '0')}` : `${s}s`;
}

// PDF-safe icon (no emoji — pdfkit Helvetica doesn't support emoji code points)
// Each note also carries iconPdf for the PDF rendering path.
function makeNote(icon, title, text, iconPdf) {
  return { icon, title, text, iconPdf: iconPdf || '[*]' };
}

export function generateCoaching(analysis = {}) {
  const laps = analysis.laps || [];
  const stats = analysis.lapStats || {};
  const metrics = analysis.metrics || {};
  const summary = analysis.summary || {};
  const notes = [];

  const validLaps = laps.filter(l => (l.time ?? l.lapTime ?? 0) > 0);
  const lapCount = stats.count ?? summary.lapCount ?? validLaps.length;

  // ── Consistency ────────────────────────────────────────────────────────
  if (validLaps.length >= 3) {
    const times = validLaps.map(l => l.time ?? l.lapTime);
    const best = Math.min(...times);
    const worst = Math.max(...times);
    const spread = worst - best;
    const spreadPct = best > 0 ? (spread / best) * 100 : 0;
    if (spreadPct < 1.5) {
      notes.push(makeNote('🎯', 'Excellent consistency',
        `Your lap times are within ${spread.toFixed(2)}s across the session (${spreadPct.toFixed(1)}%). That repeatability is exactly what lets you push the limit safely — you have a stable baseline to build on.`,
        '[+!]'));
    } else if (spreadPct < 4) {
      notes.push(makeNote('📊', 'Solid consistency, room to tighten',
        `Lap spread is ${spread.toFixed(2)}s (${spreadPct.toFixed(1)}%). Focus on hitting the same braking markers and apexes every lap — shaving the variance usually finds "free" time without riding harder.`,
        '[~]'));
    } else {
      notes.push(makeNote('🔧', 'Work on consistency first',
        `Lap times vary by ${spread.toFixed(2)}s (${spreadPct.toFixed(1)}%). Before chasing outright pace, aim for repeatable lines and braking points — consistency is the foundation of speed.`,
        '[*]'));
    }
  }

  // ── Fastest lap placement (warm-up / fade) ───────────────────────────────
  if (validLaps.length >= 4) {
    const times = validLaps.map(l => l.time ?? l.lapTime);
    const best = Math.min(...times);
    const bestPos = times.indexOf(best) / (times.length - 1); // 0=start, 1=end
    if (bestPos <= 0.34) {
      notes.push(makeNote('🔥', 'Strong early pace',
        `Your best lap (${fmtTime(best)}) came early in the session. Watch for late-session fade — hydration, tyre temp, and focus tend to drop off. If you fade, it's a fitness/tyre-management cue.`,
        '[^!]'));
    } else if (bestPos >= 0.66) {
      notes.push(makeNote('📈', 'You build into it',
        `Your best lap (${fmtTime(best)}) came late in the session — you warm up into your pace. Consider a more deliberate out-lap warm-up so you're on pace sooner and get more fast laps per session.`,
        '[v]'));
    }
  }

  // ── Top speed ────────────────────────────────────────────────────────────
  if (metrics.maxSpeed) {
    notes.push(makeNote('🏁', 'Top speed',
      `Peak of ${Math.round(metrics.maxSpeed)} km/h. If your trap speed trails riders on similar machinery, the time is usually in corner exit onto the straight — get the bike picked up and on the throttle earlier off the preceding corner.`,
      '[>>]'));
  }

  // ── Braking G ──────────────────────────────────────────────────────────
  const brakeG = metrics.maxGForces?.braking || 0;
  if (brakeG > 0) {
    if (brakeG < 0.9) {
      notes.push(makeNote('🛑', 'Braking has headroom',
        `Peak braking of ${brakeG.toFixed(1)}G suggests there's more to give. Modern sport tyres routinely take 1.1–1.3G. Try braking a touch later and harder into your best-marked corners — trail off the lever as you tip in.`,
        '[BRK]'));
    } else {
      notes.push(makeNote('💪', 'Strong braking force',
        `You're pulling ${brakeG.toFixed(1)}G on the brakes — that's committed. Make sure you're releasing (trail-braking) smoothly to the apex rather than dumping the brakes, to keep the front loaded and the line tight.`,
        '[G!]'));
    }
  }

  // ── Cornering G ──────────────────────────────────────────────────────────
  const cornerG = metrics.maxGForces?.cornering || 0;
  if (cornerG > 0) {
    notes.push(makeNote('🌀', 'Cornering load',
      `Peak lateral load of ${cornerG.toFixed(1)}G. Consistent, high mid-corner G with a smooth trace is the goal — spikes usually mean mid-corner corrections. Smoothing those out protects grip and adds exit drive.`,
      '[<<]'));
  }

  // ── Sector opportunity (theoretical best) ─────────────────────────────────
  if (analysis.idealLap && stats.best && analysis.idealLap.time && analysis.idealLap.time < stats.best) {
    const gain = stats.best - analysis.idealLap.time;
    if (gain > 0.05) {
      notes.push(makeNote('⏱️', 'Theoretical best lap',
        `Stringing together your best sectors gives a theoretical ${fmtTime(analysis.idealLap.time)} — about ${gain.toFixed(2)}s under your actual best (${fmtTime(stats.best)}). That gap is real, achievable time already in you; it's just not on one lap yet.`,
        '[T!]'));
    }
  }

  // ── Which sector to attack (biggest loss vs your own best in that sector) ──
  // For each sector, find each lap's time-in-sector isn't stored, so we use
  // sector avg speed as the proxy: the sector where your best lap trails your
  // session-best sector speed the most is where the time is hiding.
  try {
    const sectored = validLaps.filter(l => Array.isArray(l.sectors) && l.sectors.length);
    if (sectored.length >= 3) {
      const nSec = Math.max(...sectored.map(l => l.sectors.length));
      const bestSpeedPerSector = [];
      for (let s = 0; s < nSec; s++) {
        const speeds = sectored.map(l => l.sectors[s]?.avgSpeed || 0).filter(v => v > 0);
        bestSpeedPerSector[s] = speeds.length ? Math.max(...speeds) : 0;
      }
      // Best lap object
      const times = sectored.map(l => l.time ?? l.lapTime);
      const bestLap = sectored[times.indexOf(Math.min(...times))];
      let worstSec = -1, worstGapPct = 0;
      for (let s = 0; s < nSec; s++) {
        const mine = bestLap.sectors[s]?.avgSpeed || 0;
        const best = bestSpeedPerSector[s] || 0;
        if (best > 0 && mine > 0) {
          const gapPct = ((best - mine) / best) * 100;
          if (gapPct > worstGapPct) { worstGapPct = gapPct; worstSec = s; }
        }
      }
      if (worstSec >= 0 && worstGapPct > 0.8) {
        notes.push(makeNote('🎯', `Focus sector: S${worstSec + 1}`,
          `On your best lap, Sector ${worstSec + 1} was ${worstGapPct.toFixed(1)}% down on your own quickest pace through that stretch (avg ${Math.round(bestLap.sectors[worstSec].avgSpeed)} vs ${Math.round(bestSpeedPerSector[worstSec])} km/h elsewhere). That's your highest-value area — you've already gone faster there on another lap, so the speed is in you. Rebuild that lap's braking marker and apex and line for S${worstSec + 1}.`,
          '[S!]'));
      }
    }
  } catch (_) { /* sector coaching best-effort */ }

  // ── Pace progression trend (are you still improving at the end?) ──────────
  if (validLaps.length >= 5) {
    const times = validLaps.map(l => l.time ?? l.lapTime);
    const firstHalf = times.slice(0, Math.floor(times.length / 2));
    const lastHalf = times.slice(Math.ceil(times.length / 2));
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const improve = avg(firstHalf) - avg(lastHalf);
    const bestIdx = times.indexOf(Math.min(...times));
    if (bestIdx >= times.length - 2 && improve > 0.3) {
      notes.push(makeNote('🚀', 'Still finding time at the flag',
        `You were ${improve.toFixed(2)}s/lap quicker in the back half and your best lap came near the end — you hadn't plateaued when the session stopped. A longer stint (or a second session at that pace) likely has more time in it. Bank a proper warm-up so you reach this window sooner.`,
        '[^^]'));
    }
  }

  // ── Lean angle (RaceBox provides it; flag asymmetry L vs R) ───────────────
  try {
    const leans = (analysis._leanAngles || []).filter(v => isFinite(v));
    if (leans.length > 200) {
      const maxL = Math.max(...leans.map(v => Math.max(0, v)));   // left positive
      const maxR = Math.max(...leans.map(v => Math.max(0, -v)));  // right negative
      const peak = Math.max(maxL, maxR);
      if (peak > 15) {
        const diff = Math.abs(maxL - maxR);
        if (diff > 6) {
          const lean = maxL > maxR ? 'left' : 'right';
          const shy = maxL > maxR ? 'right' : 'left';
          notes.push(makeNote('↩️', 'Lean-angle asymmetry',
            `You reach ~${Math.round(peak)}° max lean, but you're carrying ${Math.round(diff)}° more on ${lean}-handers than ${shy}. That usually means the ${shy} side has more to give — often a body-position or commitment habit. Worth some focused laps favoring your weaker side.`,
            '[<>]'));
        } else {
          notes.push(makeNote('↩️', 'Balanced lean angle',
            `Peak lean around ${Math.round(peak)}°, and left/right are well matched — a sign of even body position and commitment both ways. Good foundation to push mid-corner speed evenly.`,
            '[<>]'));
        }
      }
    }
  } catch (_) { /* lean coaching best-effort */ }

  // ── Fallback ─────────────────────────────────────────────────────────────
  if (notes.length === 0) {
    notes.push(makeNote('📋', 'Baseline captured',
      `We've logged ${lapCount} lap${lapCount === 1 ? '' : 's'} at ${summary.trackName || 'this track'}. Upload a full multi-lap session to unlock consistency, sector, and pace-trend coaching.`,
      '[i]'));
  }

  // Headline summary
  const headline = validLaps.length >= 3
    ? `Over ${lapCount} laps at ${summary.trackName || 'the track'}, your best was ${fmtTime(stats.best)}. Here's where the time is:`
    : `Session at ${summary.trackName || 'the track'} analyzed. Key observations below:`;

  return { summary: headline, notes };
}

export default { generateCoaching };
