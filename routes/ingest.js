/**
 * MotoTrackIQ — ESP32 BLE Bridge Ingest Endpoint
 * ================================================
 * Accepts raw CSV batch uploads from ESP32 bridge devices.
 * No auth required — designed for local LAN use only.
 *
 * POST /api/sessions/ingest
 *   Headers:
 *     Content-Type:    text/csv
 *     X-Rider-Name:    "Rider 1"
 *     X-Device-Slot:   "1"          (1–4)
 *     X-Session-Time:  "12345"       (ms since session start on ESP32)
 *   Body: CSV rows (without header, or with — header is ignored)
 *
 * POST /api/sessions/ingest/end
 *   Headers:
 *     X-Device-Slot:   "1"
 *     X-Rider-Name:    "Rider 1"
 *   Body: { "track": "Shannonville", "bike": "CBR600RR" }
 *   → Finalizes the session, runs AI analysis, returns session ID
 *
 * GET /api/sessions/ingest/status
 *   → Returns current buffer status for all active slots
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { analyzeCSV }   from '../lib/analyzer.js';
import { createSessionData } from '../lib/db.js';

const router = express.Router();

// ── In-memory session buffers per device slot ─────────────────────────────────
// Map: slotNumber → { riderName, rows: string[], startTime, lastUpdate, totalPackets }
const slotBuffers = new Map();

const CSV_HEADER = 'itow,lat,lon,altMsl,speed_mps,heading_deg,fixType,numSV,' +
                   'gX_g,gY_g,gZ_g,rX_dps,rY_dps,rZ_dps,battery_pct';

function getOrCreateSlot(slot, riderName) {
  if (!slotBuffers.has(slot)) {
    slotBuffers.set(slot, {
      riderName: riderName || `Rider ${slot}`,
      rows: [],
      startTime: Date.now(),
      lastUpdate: Date.now(),
      totalPackets: 0,
      batchCount: 0,
    });
    console.log(`[Ingest] New session: Slot ${slot} — ${riderName}`);
  }
  return slotBuffers.get(slot);
}

// ── POST /api/sessions/ingest — receive a CSV batch ───────────────────────────
router.post('/', express.text({ type: 'text/csv', limit: '2mb' }), (req, res) => {
  const slot       = parseInt(req.headers['x-device-slot'] || '1', 10);
  const riderName  = req.headers['x-rider-name'] || `Rider ${slot}`;
  const sessionMs  = parseInt(req.headers['x-session-time'] || '0', 10);

  if (!req.body || req.body.trim() === '') {
    return res.status(400).json({ error: 'Empty CSV body' });
  }

  const buf = getOrCreateSlot(slot, riderName);
  buf.lastUpdate  = Date.now();
  buf.batchCount++;

  // Parse and append rows (skip header if present)
  const lines = req.body.trim().split('\n');
  let added = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('itow')) continue;  // skip header/empty
    buf.rows.push(trimmed);
    added++;
  }
  buf.totalPackets += added;

  console.log(`[Ingest] Slot ${slot} (${riderName}): +${added} pkts | ` +
              `total=${buf.totalPackets} | session=${Math.round(sessionMs/1000)}s`);

  res.json({
    ok: true,
    slot,
    riderName,
    totalPackets: buf.totalPackets,
    batchCount:   buf.batchCount,
    sessionMs,
  });
});

// ── POST /api/sessions/ingest/end — finalize and analyze ─────────────────────
router.post('/end', express.json(), async (req, res) => {
  const slot      = parseInt(req.headers['x-device-slot'] || req.body?.slot || '1', 10);
  const riderName = req.headers['x-rider-name'] || req.body?.riderName;
  const track     = req.body?.track   || 'Unknown Track';
  const bike      = req.body?.bike    || '';

  const buf = slotBuffers.get(slot);
  if (!buf || buf.rows.length === 0) {
    return res.status(404).json({
      error: `No active session for slot ${slot}`,
      activeSlots: [...slotBuffers.keys()],
    });
  }

  const name = riderName || buf.riderName;
  console.log(`[Ingest] Finalizing slot ${slot}: ${buf.totalPackets} packets — ${name}`);

  // Build full CSV with header
  const csv = [CSV_HEADER, ...buf.rows].join('\n');

  // Clear buffer immediately
  slotBuffers.delete(slot);

  // Run AI analysis
  let analysis;
  try {
    analysis = analyzeCSV(csv);
  } catch (err) {
    console.error('[Ingest] Analysis failed:', err.message);
    return res.status(422).json({
      error: 'Analysis failed',
      detail: err.message,
      packetCount: buf.totalPackets,
    });
  }

  // Persist session
  const session = createSessionData({
    id:           uuidv4(),
    riderId:      `bridge-slot-${slot}`,
    name:         `${name} — ${track} (ESP32)`,
    track,
    bike:         bike || null,
    date:         new Date().toISOString(),
    csvContent:   csv,
    analysisData: analysis,
    source:       'esp32-bridge',
  });

  const { csvContent, ...safe } = session;
  console.log(`[Ingest] Session saved: ${session.id} | laps: ${analysis.laps?.length || 0}`);

  res.status(201).json({
    ok:        true,
    sessionId: session.id,
    riderName: name,
    track,
    laps:      analysis.laps?.length || 0,
    bestLap:   analysis.lapStats?.bestLap || null,
    analysis:  { summary: analysis.summary, lapStats: analysis.lapStats },
  });
});

// ── GET /api/sessions/ingest/status ──────────────────────────────────────────
router.get('/status', (req, res) => {
  const status = {};
  slotBuffers.forEach((buf, slot) => {
    const ageS = Math.round((Date.now() - buf.lastUpdate) / 1000);
    status[`slot_${slot}`] = {
      riderName:    buf.riderName,
      totalPackets: buf.totalPackets,
      batchCount:   buf.batchCount,
      sessionMinutes: Math.round((Date.now() - buf.startTime) / 60000),
      lastUpdateAgo:  `${ageS}s ago`,
      stale:          ageS > 60,
    };
  });

  res.json({
    activeSlots: slotBuffers.size,
    slots: status,
    note: 'POST /api/sessions/ingest/end with X-Device-Slot header to finalize a session',
  });
});

// ── DELETE /api/sessions/ingest/discard — cancel a session ───────────────────
router.delete('/discard', (req, res) => {
  const slot = parseInt(req.headers['x-device-slot'] || req.query.slot || '1', 10);
  if (slotBuffers.has(slot)) {
    const count = slotBuffers.get(slot).totalPackets;
    slotBuffers.delete(slot);
    res.json({ ok: true, slot, discardedPackets: count });
  } else {
    res.status(404).json({ error: `No active session for slot ${slot}` });
  }
});

export default router;
