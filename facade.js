/**
 * MotoTrackIQ — Prod Compatibility Facade
 * ================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Production (Railway) still runs the JUNE 17 build (`c44fc19`), which has two
 * data-shape bugs that the CURRENT portal (and the current backend build)
 * cannot work with:
 *
 *   BUG 1 — PDF report renders blank.
 *     June's `lib/reportGenerator.js` reads lap fields `lapTime`, `topSpeed`,
 *     `maxBraking`, `maxCornering` — but June's own analyzer emits `time`,
 *     `maxSpeed`, `maxG`. Every lap row therefore renders "—" / 0 km/h / 0.0G.
 *
 *   BUG 2 — No track heatmap, no axis labels.
 *     June's `generateAllVisualizations()` has NO `trackMap` key, and its
 *     Chart.js configs set `scales.x.display = false` with no axis titles.
 *     The GPS speed-heat racing line simply does not exist in the June build.
 *
 *   BUG 3 — Sessions list goes empty in the portal.
 *     June's analyzer returns `summary.sessionDate` as a numeric epoch (ms),
 *     and the portal's `loadDayProgress()` calls `.slice(0,10)` on it →
 *     TypeError → swallowed by loadSessions' catch → `renderSessions([])`,
 *     which wipes an already-rendered table.
 *
 * WHAT THIS DOES
 * --------------
 * A thin HTTP facade in front of production that:
 *   - proxies auth/session CRUD to production (prod stays the source of truth),
 *   - re-analyzes stored session CSVs with the CURRENT analyzer
 *     (which emits `time`/`maxSpeed`/`maxG` + `visualizations.trackMap`),
 *   - renders PDFs with the CURRENT reportGenerator (real lap rows, GPS
 *     speed-heat track map, labelled axes),
 *   - normalizes date fields so the portal's session list never breaks.
 *
 * It is a stopgap until the current backend build is deployed to Railway.
 * The portal treats it as an ACCELERATOR, not a hard dependency: every route
 * falls back to production when the facade is unavailable.
 *
 * Routes:
 *   ANY  /api/*                 → proxied to prod (except the ones below)
 *   POST /api/report            → current-analyzer PDF from an uploaded CSV
 *   POST /api/sessions/:id/report → current-analyzer PDF from a stored session
 *   GET  /api/sessions          → prod list + re-analyzed analysisData + date fix
 *   POST /api/sessions          → prod save, response enriched with re-analysis
 *   GET  /api/sessions/:id      → prod session + re-analyzed analysisData
 */

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { analyzeCSV } from './lib/analyzer.js';
import { generateReport } from './lib/reportGenerator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROD = process.env.MTIQ_PROD_BACKEND || 'https://mototrack-iq-backend-production.up.railway.app';
const PORT = Number(process.env.PORT || 3019);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// ── Re-analysis cache ───────────────────────────────────────────────────────
// Re-analyzing a 700KB CSV costs ~120ms, so cache by session id + CSV hash.
// Cheap insurance against a portal render loop hammering the analyzer.
const CACHE_MAX = 60;
const cache = new Map();

function cacheKey(id, csv) {
  let h = 5381;
  const step = Math.max(1, Math.floor(csv.length / 4096));
  for (let i = 0; i < csv.length; i += step) h = ((h << 5) + h + csv.charCodeAt(i)) | 0;
  return `${id}:${csv.length}:${h >>> 0}`;
}

function cacheGet(k) {
  if (!cache.has(k)) return null;
  const v = cache.get(k);
  cache.delete(k);
  cache.set(k, v); // refresh LRU position
  return v;
}

function cacheSet(k, v) {
  cache.set(k, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * Re-analyze a raw session CSV with the CURRENT analyzer.
 * Returns { analysis, fromCache }.
 */
function reanalyze(id, csv) {
  if (!csv || typeof csv !== 'string' || csv.length < 10) return null;
  const key = cacheKey(id, csv);
  const hit = cacheGet(key);
  if (hit) return { analysis: hit, fromCache: true };
  let analysis;
  try {
    analysis = analyzeCSV(csv);
  } catch (e) {
    console.error('[facade] analyze failed:', e.message);
    return null;
  }
  cacheSet(key, analysis);
  return { analysis, fromCache: false };
}

// ── Date normalization ───────────────────────────────────────────────────────
// June's analyzer emits `sessionDate` as a numeric epoch; the portal expects an
// ISO-ish string it can call .slice(0,10) on. Normalize both `date` and
// `summary.sessionDate` to 'YYYY-MM-DD'.

function toDateKey(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms > 0) {
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

function normalizeSessionDates(session) {
  if (!session || typeof session !== 'object') return session;
  const s = { ...session };
  const a = s.analysisData ? { ...s.analysisData } : null;

  if (a) {
    if (a.summary) {
      a.summary = { ...a.summary };
      const k = toDateKey(a.summary.sessionDate);
      if (k) a.summary.sessionDate = k;
      if (a.summary.sessionDate === undefined) a.summary.sessionDate = null;
    }
  }

  // Session-level `date`: keep the numeric epoch out of the portal's way by
  // exposing a clean YYYY-MM-DD. The original is preserved as `dateRaw`.
  const dk = toDateKey(s.date) || (a && a.summary ? toDateKey(a.summary.sessionDate) : null);
  if (dk) {
    if (s.date !== undefined) s.dateRaw = s.date;
    s.date = dk;
  }

  if (a) s.analysisData = a;
  return s;
}

// ── Upstream helpers ────────────────────────────────────────────────────────

async function prodFetch(pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const res = await fetch(PROD + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return res;
}

function bearerFrom(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// ── Routes that need the CURRENT analyzer / reportGenerator ─────────────────

/**
 * POST /api/analyze — analyze an uploaded CSV with the CURRENT analyzer.
 *
 * June's analyzer returns `summary.sessionDate` as a numeric epoch and no
 * `visualizations.trackMap`. The portal's day-progress grouping calls
 * `.slice(0,10)` on that value → TypeError → the sessions table wipes itself.
 * Re-analyzing here keeps the portal on a consistent data shape.
 */
app.post('/api/analyze', upload.single('file'), async (req, res) => {
  try {
    const csv = req.file ? req.file.buffer.toString('utf8') : req.body.csv;
    if (!csv) return res.status(400).json({ error: 'No CSV provided' });
    const analysis = analyzeCSV(csv);
    // Normalize sessionDate so the portal can always call .slice(0,10).
    if (analysis.summary) {
      const k = toDateKey(analysis.summary.sessionDate);
      if (k) analysis.summary.sessionDate = k;
    }
    res.json({ success: true, data: analysis });
  } catch (err) {
    console.error('[facade] /api/analyze failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/report — upload a CSV, get a PDF back.
 * Mirrors the current build's route but renders with the current generator.
 */
app.post('/api/report', upload.single('file'), async (req, res) => {
  try {
    const csv = req.file ? req.file.buffer.toString('utf8') : req.body.csv;
    if (!csv) return res.status(400).json({ error: 'No CSV provided' });

    const analysis = analyzeCSV(csv);
    const riderName = req.body.riderName || 'Rider';
    const bikeName = req.body.bikeName || '';
    const pdf = await generateReport(analysis, { riderName, bikeName });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="MotoTrackIQ-Report.pdf"');
    const credits = req.body.reportCredits;
    if (credits !== undefined) res.setHeader('X-Report-Credits-Remaining', String(credits));
    res.send(pdf);
  } catch (err) {
    console.error('[facade] /api/report failed:', err);
    res.status(500).json({ error: 'Report failed', detail: err.message });
  }
});

/**
 * GET /api/sessions/:id — prod session + re-analyzed analysisData.
 */
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const token = bearerFrom(req);
    const upstream = await prodFetch(`/api/sessions/${encodeURIComponent(req.params.id)}`, { token });
    const ct = upstream.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.status(upstream.status).send(buf);
    }
    const data = await upstream.json();
    if (!data || !data.session) return res.status(upstream.status).json(data);

    const sess = normalizeSessionDates(data.session);
    const csv = sess.csvContent;
    if (csv) {
      const r = reanalyze(sess.id, csv);
      if (r) sess.analysisData = r.analysis;
      delete sess.csvContent;
    }
    res.json({ ...data, session: sess, facade: true });
  } catch (err) {
    console.error('[facade] GET session failed:', err);
    res.status(502).json({ error: 'Upstream unreachable', detail: err.message });
  }
});

/**
 * GET /api/sessions — prod list, each session re-analyzed + date-normalized.
 */
app.get('/api/sessions', async (req, res) => {
  try {
    const token = bearerFrom(req);
    const upstream = await prodFetch('/api/sessions', { token });
    const ct = upstream.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.status(upstream.status).send(buf);
    }
    const data = await upstream.json();
    if (!data || !Array.isArray(data.sessions)) return res.status(upstream.status).json(data);

    // Fetch full sessions (they carry csvContent) so we can re-analyze.
    const enriched = await Promise.all(data.sessions.map(async (s) => {
      const sess = normalizeSessionDates(s);
      try {
        const r = await prodFetch(`/api/sessions/${encodeURIComponent(s.id)}`, { token });
        if (r.ok) {
          const full = await r.json();
          if (full && full.session && full.session.csvContent) {
            const re = reanalyze(s.id, full.session.csvContent);
            if (re) sess.analysisData = re.analysis;
          }
        }
      } catch (_) { /* keep the prod analysisData if the detail fetch fails */ }
      return sess;
    }));

    res.json({ ...data, sessions: enriched, facade: true });
  } catch (err) {
    console.error('[facade] GET sessions failed:', err);
    res.status(502).json({ error: 'Upstream unreachable', detail: err.message });
  }
});

/**
 * POST /api/sessions — save to prod, respond with re-analyzed analysis.
 */
app.post('/api/sessions', async (req, res) => {
  try {
    const token = bearerFrom(req);
    const upstream = await prodFetch('/api/sessions', {
      method: 'POST', token, body: req.body,
    });
    const ct = upstream.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.status(upstream.status).send(buf);
    }
    const data = await upstream.json();
    if (!data || !data.session) return res.status(upstream.status).json(data);

    const sess = normalizeSessionDates(data.session);
    // The caller already gave us the CSV — re-analyze without another round-trip.
    if (req.body && req.body.csvContent) {
      const r = reanalyze(sess.id, req.body.csvContent);
      if (r) sess.analysisData = r.analysis;
    }
    res.status(upstream.status).json({ ...data, session: sess, facade: true });
  } catch (err) {
    console.error('[facade] POST session failed:', err);
    res.status(502).json({ error: 'Upstream unreachable', detail: err.message });
  }
});

/**
 * POST /api/sessions/:id/report — PDF from a stored session, re-analyzed.
 */
app.post('/api/sessions/:id/report', async (req, res) => {
  try {
    const token = bearerFrom(req);
    const upstream = await prodFetch(`/api/sessions/${encodeURIComponent(req.params.id)}`, { token });
    if (!upstream.ok) {
      const ct = upstream.headers.get('content-type') || '';
      if (ct.includes('application/json')) return res.status(upstream.status).json(await upstream.json());
      return res.status(upstream.status).json({ error: 'Upstream error' });
    }
    const data = await upstream.json();
    const sess = data && data.session;
    if (!sess) return res.status(404).json({ error: 'Not found' });

    let analysis = null;
    if (sess.csvContent) {
      const r = reanalyze(sess.id, sess.csvContent);
      if (r) analysis = r.analysis;
    }
    // Fall back to the stored analysis if we couldn't re-analyze.
    if (!analysis) analysis = sess.analysisData;

    const pdf = await generateReport(analysis, {
      riderName: (req.body && req.body.riderName) || sess.riderName || 'Rider',
      bikeName: (req.body && req.body.bikeName) || sess.bike || '',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="mototrackiq-report-${sess.id}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[facade] report failed:', err);
    res.status(500).json({ error: 'Report failed', detail: err.message });
  }
});

/**
 * POST /api/device/upload — BLE Sync upload.
 * Must forward the file as multipart, so it is handled explicitly rather than
 * by the generic proxy (which can only carry JSON).
 */
app.post('/api/device/upload', upload.single('file'), async (req, res) => {
  try {
    const token = bearerFrom(req);
    const fd = new FormData();
    if (req.file) {
      fd.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'text/csv' }), req.file.originalname || 'session.csv');
    }
    for (const [k, v] of Object.entries(req.body || {})) {
      if (typeof v === 'string') fd.append(k, v);
    }
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const upstream = await fetch(`${PROD}/api/device/upload`, { method: 'POST', headers, body: fd });
    const ct = upstream.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      return res.status(upstream.status).json(await upstream.json());
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.send(buf);
  } catch (err) {
    console.error('[facade] device/upload failed:', err);
    res.status(502).json({ error: 'Upstream unreachable', detail: err.message });
  }
});

// ── Everything else → proxy straight to production ──────────────────────────
app.use('/api', async (req, res) => {
  try {
    const token = bearerFrom(req);
    const isJson = !req.is('multipart/form-data') && !req.is('application/x-www-form-urlencoded');
    // GET/HEAD must never carry a body — undici throws
    // "Request with GET/HEAD method cannot have body." and the whole
    // request dies as a 502 instead of reaching production.
    const canHaveBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = canHaveBody && isJson ? JSON.stringify(req.body || {}) : undefined;
    const upstream = await prodFetch(req.originalUrl, {
      method: req.method, token, body,
      headers: isJson ? { 'Content-Type': 'application/json' } : {},
    });
    const ct = upstream.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const text = await upstream.text();
      return res.status(upstream.status).send(text);
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const cc = upstream.headers.get('content-disposition');
    if (cc) res.setHeader('Content-Disposition', cc);
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.send(buf);
  } catch (err) {
    console.error('[facade] proxy failed:', err);
    res.status(502).json({ error: 'Upstream unreachable', detail: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mtiq-facade', prod: PROD }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[facade] listening on :${PORT} → prod ${PROD}`);
});
