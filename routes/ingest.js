/**
 * MotoTrackIQ — ESP32 BLE Bridge Ingest Endpoint
 * ================================================
 * Accepts raw CSV batch uploads from ESP32 bridge devices.
 *
 * Auth: rider JWT, admin key, or X-Device-Token / Authorization Bearer
 * matching DEVICE_INGEST_TOKEN. There is no default token; unset means
 * those calls need a rider JWT or the admin key.
 *
 * POST /api/sessions/ingest
 *   Headers:
 *     Content-Type:    text/csv
 *     X-Rider-Name:    "Rider 1"     (markup stripped, max 60 chars)
 *     X-Device-Slot:   "1"           (1–4)
 *     X-Session-Time:  "12345"       (ms since session start on ESP32)
 *     X-Device-Token:  <DEVICE_INGEST_TOKEN>
 *   Body: CSV rows, at most INGEST_MAX_BATCH_BYTES (default 1 MiB)
 *
 * POST /api/sessions/ingest/end
 *   Headers: X-Device-Slot, X-Rider-Name, plus the same auth
 *   Body: { "track": "Shannonville", "bike": "CBR600RR" }
 *
 * GET /api/sessions/ingest/status
 * DELETE /api/sessions/ingest/discard
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { analyzeCSV }   from '../lib/analyzer.js';
import { createSessionData } from '../lib/db.js';
import { requireUserOrDevice } from '../lib/middleware/auth.js';
import { cleanRiderName } from '../lib/rider-name.js';

const router = express.Router();

router.use(requireUserOrDevice);

const DEFAULT_BATCH_BYTES = 1024 * 1024;
const DEFAULT_SLOT_BYTES = 8 * 1024 * 1024;
const MAX_SLOT_ROWS = 200_000;

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function batchLimit() {
  return boundedInt(process.env.INGEST_MAX_BATCH_BYTES, DEFAULT_BATCH_BYTES, 1024, 8 * 1024 * 1024);
}

function slotLimit() {
  return boundedInt(process.env.INGEST_MAX_SLOT_BYTES, DEFAULT_SLOT_BYTES, 1024, 32 * 1024 * 1024);
}

// ── In-memory session buffers per device slot ─────────────────────────────────
// Map: slotNumber → { riderName, rows: string[], bytes, startTime, lastUpdate, totalPackets }
const slotBuffers = new Map();

const CSV_HEADER = 'itow,lat,lon,altMsl,speed_mps,heading_deg,fixType,numSV,' +
                   'gX_g,gY_g,gZ_g,rX_dps,rY_dps,rZ_dps,battery_pct';

function deviceSlot(raw) {
  if (raw == null || raw === '') return 1;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1 || n > 4) return null;
  return n;
}

function riderFromHeader(req, slot) {
  return cleanRiderName(req.headers['x-rider-name'], { fallback: `Rider ${slot}` });
}

function getOrCreateSlot(slot, riderName) {
  if (!slotBuffers.has(slot)) {
    slotBuffers.set(slot, {
      riderName: riderName || `Rider ${slot}`,
      rows: [],
      bytes: 0,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      totalPackets: 0,
      batchCount: 0,
    });
    console.log(`[Ingest] New session: Slot ${slot} — ${riderName}`);
  }
  return slotBuffers.get(slot);
}

function label(value, max, fallback = '') {
  return cleanRiderName(value, { fallback, max });
}

// ── POST /api/sessions/ingest — receive a CSV batch ───────────────────────────
router.post('/', express.text({ type: '*/*', limit: 8 * 1024 * 1024 }), (req, res) => {
  const slot = deviceSlot(req.headers['x-device-slot']);
  if (slot == null) return res.status(400).json({ error: 'X-Device-Slot must be 1–4' });
  const riderName  = riderFromHeader(req, slot);
  const sessionMs  = parseInt(req.headers['x-session-time'] || '0', 10);

  if (typeof req.body !== 'string' || req.body.trim() === '') {
    return res.status(400).json({ error: 'Empty CSV body' });
  }
  if (Buffer.byteLength(req.body) > batchLimit()) {
    return res.status(413).json({ error: 'Upload is too large' });
  }

  const buf = getOrCreateSlot(slot, riderName);
  const lines = req.body.trim().split('\n');
  const accepted = [];
  let addedBytes = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('itow')) continue;
    if (trimmed.length > 4000) {
      return res.status(400).json({ error: 'CSV row is too long' });
    }
    addedBytes += Buffer.byteLength(trimmed) + 1;
    accepted.push(trimmed);
  }
  if (buf.rows.length + accepted.length > MAX_SLOT_ROWS || buf.bytes + addedBytes > slotLimit()) {
    return res.status(413).json({ error: 'Session buffer is full' });
  }

  buf.lastUpdate = Date.now();
  buf.batchCount++;
  buf.rows.push(...accepted);
  buf.bytes += addedBytes;
  buf.totalPackets += accepted.length;
  buf.riderName = riderName;

  console.log(`[Ingest] Slot ${slot} (${riderName}): +${accepted.length} pkts | ` +
              `total=${buf.totalPackets} | session=${Math.round((Number.isFinite(sessionMs) ? sessionMs : 0) / 1000)}s`);

  res.json({
    ok: true,
    slot,
    riderName,
    totalPackets: buf.totalPackets,
    batchCount:   buf.batchCount,
    sessionMs: Number.isFinite(sessionMs) ? sessionMs : 0,
  });
});

// ── POST /api/sessions/ingest/end — finalize and analyze ─────────────────────
router.post('/end', express.json({ limit: '32kb' }), async (req, res) => {
  const slot = deviceSlot(req.headers['x-device-slot'] || req.body?.slot);
  if (slot == null) return res.status(400).json({ error: 'X-Device-Slot must be 1–4' });
  const riderName = cleanRiderName(req.headers['x-rider-name'] || req.body?.riderName || '');
  const track     = label(req.body?.track, 80, 'Unknown Track');
  const bike      = label(req.body?.bike, 80, '');

  const buf = slotBuffers.get(slot);
  if (!buf || buf.rows.length === 0) {
    return res.status(404).json({
      error: `No active session for slot ${slot}`,
      activeSlots: [...slotBuffers.keys()],
    });
  }

  const name = riderName || buf.riderName;
  console.log(`[Ingest] Finalizing slot ${slot}: ${buf.totalPackets} packets — ${name}`);

  const csv = [CSV_HEADER, ...buf.rows].join('\n');
  slotBuffers.delete(slot);

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

  const session = createSessionData({
    id:           uuidv4(),
    riderId:      req.riderId || `bridge-slot-${slot}`,
    name:         `${name} — ${track} (ESP32)`,
    track,
    bike:         bike || null,
    date:         new Date().toISOString(),
    csvContent:   csv,
    analysisData: analysis,
  });

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
  const slot = deviceSlot(req.headers['x-device-slot'] || req.query.slot);
  if (slot == null) return res.status(400).json({ error: 'X-Device-Slot must be 1–4' });
  if (slotBuffers.has(slot)) {
    const count = slotBuffers.get(slot).totalPackets;
    slotBuffers.delete(slot);
    res.json({ ok: true, slot, discardedPackets: count });
  } else {
    res.status(404).json({ error: `No active session for slot ${slot}` });
  }
});

router.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
    return res.status(413).json({ error: 'Upload is too large' });
  }
  return next(err);
});

export default router;
