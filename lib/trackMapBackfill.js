'use strict';

/**
 * Legacy track-map backfill.
 *
 * Sessions uploaded before the analyzer started emitting
 * `visualizations.trackMap` have no map in their stored analysis, so their
 * PDF reports render without the GPS speed-heat racing line. The retired
 * compat facade used to hide this: it re-analyzed the stored CSV on every
 * request, so it always produced a fresh map. Prod serves the STORED
 * analysisData, so legacy sessions lost the map when the facade was
 * retired on Oct 23.
 *
 * The stored CSV is still on the session, so the map can be regenerated
 * from it. This module does the minimum necessary:
 *
 *   - re-analyze the stored CSV
 *   - take ONLY `visualizations.trackMap` from the fresh analysis
 *   - merge it into the stored analysisData
 *   - persist it, so the session is permanently fixed
 *
 * Deliberately does NOT overwrite the rest of the stored analysis. A full
 * re-analysis could shift metrics that riders have already been shown
 * (lap times, best lap, coaching) if the analyzer has changed since the
 * upload. The track map is a pure rendering artifact with no such coupling,
 * so merging just that key is safe.
 *
 * Newly uploaded sessions already have a trackMap and are left untouched.
 */

import { analyzeCSV } from './analyzer.js';
import { updateSessionAnalysis } from './db.js';

/**
 * Does this stored analysis already contain a usable track map?
 *
 * `renderTrackMap` needs `map.path` with at least 10 points, so a trackMap
 * object without a usable path is treated as missing.
 */
export function hasTrackMap(analysisData) {
  const tm = analysisData && analysisData.visualizations && analysisData.visualizations.trackMap;
  return !!(tm && Array.isArray(tm.path) && tm.path.length >= 10);
}

/**
 * Regenerate the track map for a session from its stored CSV.
 *
 * @param {object} session a session row, ideally including `csvContent` and
 *                         `analysisData` (getSessionById returns both)
 * @returns {{fixed: boolean, reason: string, session?: object}}
 *          `fixed` is true only when the session was actually updated
 */
export function backfillTrackMap(session) {
  if (!session || !session.id) return { fixed: false, reason: 'no session' };

  const analysis = session.analysisData;
  if (!analysis || typeof analysis !== 'object') {
    return { fixed: false, reason: 'no analysis data' };
  }

  if (hasTrackMap(analysis)) {
    return { fixed: false, reason: 'already has track map' };
  }

  if (!session.csvContent || !session.csvContent.trim()) {
    return { fixed: false, reason: 'no stored csv to re-analyze' };
  }

  let fresh;
  try {
    fresh = analyzeCSV(session.csvContent);
  } catch (err) {
    // A CSV the current analyzer can no longer parse must not break the
    // report — the rider still gets everything except the map.
    return { fixed: false, reason: `re-analysis failed: ${err.message}` };
  }

  const trackMap = fresh && fresh.visualizations && fresh.visualizations.trackMap;
  if (!trackMap || !Array.isArray(trackMap.path) || trackMap.path.length < 10) {
    // No GPS track in this CSV (e.g. a telemetry-only export with no
    // lat/lon columns). There is no map to draw, so this is not a defect.
    return { fixed: false, reason: 'no usable track map in csv (no gps data)' };
  }

  const merged = {
    ...analysis,
    visualizations: {
      ...(analysis.visualizations || {}),
      trackMap
    }
  };

  const updated = updateSessionAnalysis(session.id, merged);
  if (!updated) {
    // The write failed (transient DB error, unknown id, ...). Do NOT discard
    // the map we just generated: the rider should still get the racing line
    // in THIS report. It will simply be regenerated on the next request.
    // `fixed` stays false because the session was not permanently updated.
    return {
      fixed: false,
      reason: 'session update failed (map applied to this report only)',
      session: { ...session, analysisData: merged }
    };
  }

  return { fixed: true, reason: 'track map regenerated', session: updated };
}

export default { hasTrackMap, backfillTrackMap };
