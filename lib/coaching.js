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
