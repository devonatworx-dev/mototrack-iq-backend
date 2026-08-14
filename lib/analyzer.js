/**
 * MotoTrackIQ - RaceBox CSV Analyzer v2
 * Handles RaceBox CSV format (with metadata header rows) and standard CSV formats.
 * Uses built-in Lap column when available, falls back to GPS-based detection.
 */

import Papa from 'papaparse';
import { generateCoaching } from './coaching.js';

// ─────────────────────────────────────────────────────────────────────────────
// GPX SUPPORT
// ─────────────────────────────────────────────────────────────────────────────

/** Quick sniff: is this content a GPX/XML track file rather than CSV? */
function isGpx(content) {
  if (!content) return false;
  const head = content.slice(0, 1000).toLowerCase();
  return head.includes('<gpx') || (head.includes('<?xml') && head.includes('<trkpt')) || head.includes('<trkpt');
}

/** Haversine distance in metres between two lat/lon points. */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Convert a GPX track into RaceBox-format CSV text.
 * Emits the canonical RaceBox data header + rows so the existing pipeline
 * (format='racebox') parses it. Speed (km/h) is derived from GPS movement;
 * G-force / lean / gyro are zero (GPX carries no IMU data). Lap is left 0 so
 * GPS-gate lap detection takes over downstream.
 */
function gpxToRaceboxCsv(gpx) {
  const pts = [];
  // Match each <trkpt lat=".." lon=".."> ... </trkpt>, capturing optional <ele> and <time>.
  const trkptRe = /<trkpt[^>]*\blat="([\-0-9.]+)"[^>]*\blon="([\-0-9.]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
  // Also handle self-closing or attribute-order variants by falling back per-match.
  let m;
  while ((m = trkptRe.exec(gpx)) !== null) {
    let lat = parseFloat(m[1]);
    let lon = parseFloat(m[2]);
    const inner = m[3] || '';
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const eleM = /<ele>\s*([\-0-9.]+)\s*<\/ele>/i.exec(inner);
    const timeM = /<time>\s*([^<]+?)\s*<\/time>/i.exec(inner);
    // Some GPX put speed as an extension
    const spdM = /<(?:speed|gpxtpx:speed)>\s*([\-0-9.]+)\s*<\/(?:speed|gpxtpx:speed)>/i.exec(inner);
    pts.push({
      lat, lon,
      alt: eleM ? parseFloat(eleM[1]) : 0,
      time: timeM ? timeM[1] : null,
      spd: spdM ? parseFloat(spdM[1]) : null // m/s if present
    });
  }

  if (pts.length < 2) {
    throw new Error('GPX file contained no usable track points');
  }

  const header = 'Record,Time,Latitude,Longitude,Altitude,Speed,GForceX,GForceZ,Lap,LeanAngle,GyroX,GyroY,GyroZ';
  const rows = [header];
  let prev = null;
  let synthClock = Date.now() - pts.length * 100; // fallback if no timestamps (10 Hz)

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    let tMs;
    if (p.time) {
      const parsed = Date.parse(p.time);
      tMs = isNaN(parsed) ? (synthClock += 100) : parsed;
    } else {
      tMs = (synthClock += 100);
    }

    let speedKmh = 0;
    if (p.spd != null && isFinite(p.spd)) {
      speedKmh = p.spd * 3.6; // GPX <speed> is m/s
    } else if (prev) {
      const distM = haversineM(prev.lat, prev.lon, p.lat, p.lon);
      const dtS = Math.max(0.001, (tMs - prev.tMs) / 1000);
      speedKmh = (distM / dtS) * 3.6;
      // Guard against GPS jitter spikes: reject non-finite, absurd values, and
      // physically impossible sample-to-sample jumps (>~3g accel), holding the
      // previous speed instead. Keeps a stray bad fix from skewing top-speed.
      const maxDeltaKmh = 106 * dtS; // ~3g over the interval
      if (!isFinite(speedKmh) || speedKmh > 400) {
        speedKmh = prev.speedKmh || 0;
      } else if (prev.speedKmh != null && Math.abs(speedKmh - prev.speedKmh) > maxDeltaKmh + 5) {
        // clamp the jump toward the previous speed
        speedKmh = prev.speedKmh + Math.sign(speedKmh - prev.speedKmh) * (maxDeltaKmh + 5);
        if (speedKmh < 0) speedKmh = 0;
      }
    }

    const iso = new Date(tMs).toISOString();
    rows.push(`${i},${iso},${p.lat.toFixed(7)},${p.lon.toFixed(7)},${(p.alt || 0).toFixed(1)},${speedKmh.toFixed(2)},0,0,0,0,0,0,0`);
    prev = { lat: p.lat, lon: p.lon, tMs, speedKmh };
  }

  return rows.join('\n') + '\n';
}


/**
 * Main analysis function
 * @param {string} csvContent - Raw CSV file content
 * @returns {object} Complete analysis result
 */
export function analyzeCSV(csvContent) {
  // GPX files (.gpx / XML) are converted to the RaceBox CSV row format so the
  // existing parsing + lap-detection pipeline handles them unchanged. Speed is
  // derived from GPS distance/time between consecutive trackpoints.
  if (isGpx(csvContent)) {
    csvContent = gpxToRaceboxCsv(csvContent);
  }
  // ── Step 1: Detect format and extract metadata ──────────────────────────────
  const { metadata, dataRows, format } = parseCSVFormat(csvContent);

  if (dataRows.length === 0) {
    throw new Error('No data found in CSV');
  }

  // ── Step 2: Normalize to common column format ────────────────────────────────
  const normalized = normalizeData(dataRows, format, metadata.columnMap);

  // ── Step 3: Identify laps ──────────────────────────────────────────────────
  // RaceBox uses the built-in Lap column when present, but the phone-app export
  // often has an all-zero Lap column (no start/finish line configured), so fall
  // back to GPS-gate detection when the column yields no laps.
  let laps = [];
  if (format === 'racebox' || format === 'standard-headered') {
    laps = identifyLapsFromColumn(normalized);
    if (laps.length === 0) laps = identifyLapsByGate(normalized);
    if (laps.length === 0) laps = identifyLapsByGPS(normalized);
  } else {
    laps = identifyLapsByGate(normalized);
    if (laps.length === 0) laps = identifyLapsByGPS(normalized);
  }

  // ── Step 4: Calculate metrics ───────────────────────────────────────────────
  const metrics = calculateMetrics(normalized);
  // Prefer GPS-confirmed canonical track name; fall back to (canonicalized) metadata
  // label. GPS wins when it recognizes the venue so all riders' sessions agree on one
  // name even if their RaceBox Track fields differ or are blank.
  const gpsTrack = detectTrack(normalized);
  const metaTrack = detectTrackFromMetadata(metadata);
  const trackName = gpsTrack || metaTrack;

  // ── Step 5: Per-lap stats ──────────────────────────────────────────────────
  const lapStats = calculateLapStats(laps);

  // ── Step 6: Find ideal lap ─────────────────────────────────────────────────
  const idealLap = findIdealLap(laps, normalized);

  // ── Step 7: Lap comparison table ───────────────────────────────────────────
  const lapComparison = generateLapComparison(laps);

  // ── Step 8: Visualizations ──────────────────────────────────────────────────
  const visualizations = generateAllVisualizations(normalized, laps);

  return {
    summary: {
      totalPoints: dataRows.length,
      sessionDuration: metrics.sessionDuration,
      sessionDate: metadata.date || (normalized[0]?.timestamp || null),
      trackName: trackName || 'Unknown Track',
      lapCount: laps.length,
      deviceId: metadata.deviceId || null,
      format: format
    },
    metrics: {
      totalDistance: metrics.totalDistance,
      maxSpeed: metrics.maxSpeed,
      avgSpeed: Math.round(metrics.avgSpeed),
      maxG: Math.round(metrics.maxG * 10) / 10,
      maxGForces: {
        braking: Math.round(metrics.maxBraking * 10) / 10,
        cornering: Math.round(metrics.maxCornering * 10) / 10
      }
    },
    laps,
    lapStats,
    idealLap,
    lapComparison,
    visualizations,
    coaching: generateCoaching({ summary: { trackName: trackName || 'Unknown Track', lapCount: laps.length }, metrics: { maxSpeed: metrics.maxSpeed, avgSpeed: Math.round(metrics.avgSpeed), maxGForces: { braking: Math.round(metrics.maxBraking * 10) / 10, cornering: Math.round(metrics.maxCornering * 10) / 10 } }, laps, lapStats, idealLap, _leanAngles: normalized.map(p => p.leanAngle).filter(v => v != null && isFinite(v)) })
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT PARSING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect CSV format and extract metadata
 * RaceBox CSV has mixed format: metadata rows + lap summary rows + data table
 */
function parseCSVFormat(csvContent) {
  const lines = csvContent.split(/\r?\n/);
  const metadata = {};
  let dataStartIdx = 0;
  let format = 'standard';

  const RACEBOX_DATA_HEADER = 'Record,Time,Latitude,Longitude,Altitude,Speed,GForceX,GForceZ,Lap,LeanAngle,GyroX,GyroY,GyroZ';

  // ── Headerless RaceBox-app export: first line IS the data header ────────────
  // (RaceBox phone-app CSV export has no "Format,RaceBox CSV" metadata block;
  //  it starts directly with the column header row. Same column order.)
  if (lines[0].trim() === RACEBOX_DATA_HEADER) {
    format = 'racebox';
    dataStartIdx = 1;
    const dataLines = lines.slice(dataStartIdx);
    const parseResult = Papa.parse(dataLines.join('\n'), {
      header: false, skipEmptyLines: true, dynamicTyping: true
    });
    return { metadata, dataRows: parseResult.data || [], format };
  }

  // ── Headered standard CSV (e.g. third-party lap timer export) ──────────────
  // First line is a non-numeric column header like "Lat,Lon,Speed,LatG,LonG,Lap".
  // Map columns by name once, then parse data rows positionally.
  {
    const firstCells = lines[0].split(',').map(c => c.trim());
    const looksLikeHeader =
      firstCells.length >= 3 &&
      firstCells.every(c => c.length > 0 && isNaN(parseFloat(c))) &&
      lines[0].trim() !== RACEBOX_DATA_HEADER;
    if (looksLikeHeader) {
      const headerMap = {};
      const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
      const aliasTable = {
        time: ['time', 'timestamp', 'elapsed', 'utctime', 'datetime'],
        lat: ['lat', 'latitude'],
        lon: ['lon', 'lng', 'longitude'],
        speed: ['speed', 'velocity', 'kmh', 'speedkmh', 'speedmph', 'mph'],
        gforceLat: ['latg', 'glat', 'glateral', 'gforcex', 'lateralg', 'gx', 'accx'],
        gforceLon: ['long', 'long_g', 'glon', 'glongitudinal', 'gforcez', 'gz', 'accz', 'long_g', 'longg', 'lon_g'],
        gforce: ['gforce', 'totalg', 'gtotal'],
        alt: ['alt', 'altitude', 'elevation', 'ele'],
        lap: ['lap', 'lapnumber', 'lapnum', 'lap#']
      };
      firstCells.forEach((cell, idx) => {
        const c = norm(cell);
        for (const [field, aliases] of Object.entries(aliasTable)) {
          if (headerMap[field] !== undefined) continue;
          if (aliases.some(a => c === norm(a))) { headerMap[field] = idx; break; }
        }
      });
      // Disambiguate LatG vs LonG when both present as 'latg'/'long'
      if (headerMap.gforceLat === undefined || headerMap.gforceLon === undefined) {
        firstCells.forEach((cell, idx) => {
          const c = norm(cell);
          if (c === 'latg' && headerMap.gforceLat === undefined) headerMap.gforceLat = idx;
          if (c === 'long' && headerMap.gforceLon === undefined) headerMap.gforceLon = idx;
        });
      }
      // Require at least lat+lon+speed to treat as a valid telemetry header
      if (headerMap.lat !== undefined && headerMap.lon !== undefined && headerMap.speed !== undefined) {
        format = 'standard-headered';
        metadata.columnMap = headerMap;
        const dataLines = lines.slice(1);
        const parseResult = Papa.parse(dataLines.join('\n'), {
          header: false, skipEmptyLines: true, dynamicTyping: true
        });
        return { metadata, dataRows: parseResult.data || [], format };
      }
    }
  }

  // ── RaceBox format: first line is "Format,RaceBox CSV" ─────────────────────
  if (lines[0].trim() === 'Format,RaceBox CSV') {
    format = 'racebox';

    // Parse metadata rows until "Record," header row
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === 'Record,Time,Latitude,Longitude,Altitude,Speed,GForceX,GForceZ,Lap,LeanAngle,GyroX,GyroY,GyroZ') {
        dataStartIdx = i + 1;
        break;
      }
      const commaIdx = line.indexOf(',');
      if (commaIdx > 0) {
        const key = line.slice(0, commaIdx).trim();
        const value = line.slice(commaIdx + 1).trim();
        metadata[key] = value;
      }
    }

    // Structured metadata fields
    metadata.deviceId = metadata['Data Source'] || null;
    metadata.date = metadata['Date UTC'] || null;
    metadata.track = metadata['Track'] || null;
    metadata.configuration = metadata['Configuration'] || null;
    metadata.laps = metadata['Laps'] ? parseInt(metadata['Laps']) : null;
    metadata.bestLapTime = metadata['Best Lap Time'] ? parseFloat(metadata['Best Lap Time']) : null;

    // Parse lap summary rows: "Lap 1, 92.507, sectors, 29.246,43.611,0,19.650"
    metadata.lapSummary = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('Lap ') && line.includes('sectors')) {
        const match = line.match(/^Lap (\d+),\s*([\d.]+),\s*sectors,\s*([\d.]+),([\d.]+),(\d+),([\d.]+)/);
        if (match) {
          metadata.lapSummary.push({
            lapNumber: parseInt(match[1]),
            time: parseFloat(match[2]),
            sector1: parseFloat(match[3]),
            sector2: parseFloat(match[4]),
            sector3: parseFloat(match[6])
          });
        }
      }
    }
  }

  // ── Parse data rows ────────────────────────────────────────────────────────
  const dataLines = lines.slice(dataStartIdx);
  const parseResult = Papa.parse(dataLines.join('\n'), {
    header: false,
    skipEmptyLines: true,
    dynamicTyping: true
  });

  const dataRows = parseResult.data || [];
  return { metadata, dataRows, format };
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize data rows to common format
 * RaceBox columns: Record, Time, Latitude, Longitude, Altitude, Speed, GForceX, GForceZ, Lap, LeanAngle, GyroX, GyroY, GyroZ
 */
function normalizeData(dataRows, format, columnMap) {
  const result = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (!row || row.length < 3) continue;

    let timestamp = null, lat = 0, lon = 0, speed = 0, gforce = 0, gLat = 0, gLon = 0, alt = 0;
    let lap = null, leanAngle = 0, gyroX = 0, gyroY = 0, gyroZ = 0;

    if (format === 'standard-headered' && columnMap) {
      // Header-mapped third-party telemetry (e.g. Lat,Lon,Speed,LatG,LonG,Lap).
      // Speed is taken as-is (already km/h); no m/s conversion.
      const cm = columnMap;
      if (cm.time !== undefined && row[cm.time]) {
        const t = new Date(row[cm.time]).getTime();
        timestamp = isNaN(t) ? null : t;
      }
      lat   = cm.lat       !== undefined ? parseFloat(row[cm.lat])   || 0 : 0;
      lon   = cm.lon       !== undefined ? parseFloat(row[cm.lon])   || 0 : 0;
      speed = cm.speed     !== undefined ? parseFloat(row[cm.speed]) || 0 : 0;
      gLat  = cm.gforceLat !== undefined ? parseFloat(row[cm.gforceLat]) || 0 : 0;
      gLon  = cm.gforceLon !== undefined ? parseFloat(row[cm.gforceLon]) || 0 : 0;
      gforce = cm.gforce   !== undefined
        ? (parseFloat(row[cm.gforce]) || 0)
        : Math.sqrt(gLat * gLat + gLon * gLon);
      alt   = cm.alt       !== undefined ? parseFloat(row[cm.alt]) || 0 : 0;
      lap   = cm.lap       !== undefined ? (parseInt(row[cm.lap]) || 0) : null;
      result.push({ index: i, timestamp, lat, lon, speed, gforce, gLat, gLon, alt, lap, leanAngle, gyroX, gyroY, gyroZ });
      continue;
    }

    if (format === 'racebox') {
      // RaceBox columns: 0=Record, 1=Time, 2=Lat, 3=Lon, 4=Alt, 5=Speed(km/h), 6=GForceX, 7=GForceZ, 8=Lap, 9=LeanAngle, 10=GyroX, 11=GyroY, 12=GyroZ
      timestamp = row[1] ? new Date(row[1]).getTime() : null;
      lat = parseFloat(row[2]) || 0;
      lon = parseFloat(row[3]) || 0;
      alt = parseFloat(row[4]) || 0;
      speed = parseFloat(row[5]) || 0;    // km/h
      gLat = parseFloat(row[6]) || 0;    // lateral g
      gLon = parseFloat(row[7]) || 0;     // longitudinal g
      gforce = Math.sqrt(gLat * gLat + gLon * gLon);
      lap = row[8] !== undefined ? parseInt(row[8]) : null;
      leanAngle = parseFloat(row[9]) || 0;
      gyroX = parseFloat(row[10]) || 0;
      gyroY = parseFloat(row[11]) || 0;
      gyroZ = parseFloat(row[12]) || 0;
    } else {
      // Standard CSV: detect columns dynamically
      const cols = detectColumns(row);
      timestamp = cols.time !== undefined ? (row[cols.time] ? new Date(row[cols.time]).getTime() : null) : null;
      lat = cols.lat !== undefined ? parseFloat(row[cols.lat]) || 0 : 0;
      lon = cols.lon !== undefined ? parseFloat(row[cols.lon]) || 0 : 0;
      speed = cols.speed !== undefined ? parseFloat(row[cols.speed]) || 0 : 0;
      if (speed > 100) speed = speed / 3.6; // m/s → km/h
      gforce = cols.gforce !== undefined ? parseFloat(row[cols.gforce]) || 0 : 0;
      gLat = cols.gforceLat !== undefined ? parseFloat(row[cols.gforceLat]) || 0 : 0;
      gLon = cols.gforceLon !== undefined ? parseFloat(row[cols.gforceLon]) || 0 : 0;
      alt = cols.alt !== undefined ? parseFloat(row[cols.alt]) || 0 : 0;
    }

    result.push({ index: i, timestamp, lat, lon, speed, gforce, gLat, gLon, alt, lap, leanAngle, gyroX, gyroY, gyroZ });
  }

  return result;
}

/**
 * Detect column indices for standard CSV
 */
function detectColumns(row) {
  if (!row || typeof row !== 'object') return {};
  const keys = Array.isArray(row) ? row : Object.keys(row);
  const aliases = {
    time: ['time', 'timestamp', 'elapsed'],
    lat: ['lat', 'latitude'],
    lon: ['lon', 'longitude', 'lng'],
    speed: ['speed', 'velocity', 'kmh', 'speed_kmh'],
    gforce: ['gforce', 'g-force', 'total_g'],
    gforceLat: ['gforce_lat', 'g_lateral', 'gforcex'],
    gforceLon: ['gforce_lon', 'g_longitudinal', 'gforcez'],
    alt: ['alt', 'elevation', 'ele', 'altitude']
  };
  const found = {};
  for (const [field, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      const idx = keys.findIndex(k => String(k).toLowerCase().includes(alias));
      if (idx !== -1) { found[field] = idx; break; }
    }
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// LAP DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identify laps using the built-in Lap column (RaceBox format)
 * Most accurate method — RaceBox numbers each sample with a lap counter
 */
function identifyLapsFromColumn(data) {
  if (data.length < 50) return [];

  const laps = [];
  let currentLapNumber = null;
  let lapStartIdx = 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const lapNum = row.lap;

    // Skip rows with no lap number or lap = 0 (pre-lap stationary / countdown)
    if (lapNum === null || lapNum === 0) continue;

    if (currentLapNumber === null) {
      // First valid lap row — start tracking
      currentLapNumber = lapNum;
      lapStartIdx = i;
    } else if (lapNum !== currentLapNumber) {
      // Lap transition — close current lap
      const lapData = data.slice(lapStartIdx, i);
      if (lapData.length >= 10) {
        const firstTs = lapData[0].timestamp;
        const lastTs = lapData[lapData.length - 1].timestamp;
        const speeds = lapData.map(d => d.speed);
        const gForces = lapData.map(d => Math.abs(d.gforce));
        const lapDist = calculateDistance(lapData);
        // Timestamps from getTime() are in ms — divide by 1000 for seconds.
        // No timestamps (e.g. third-party lap-timer export): derive lap time from
        // GPS distance / average speed, which is physically accurate.
        const avgSpd = speeds.reduce((a, b) => a + b, 0) / speeds.length;
        const lapTime = (firstTs && lastTs && lastTs > firstTs)
          ? Math.round((lastTs - firstTs) / 1000 * 100) / 100
          : (avgSpd > 1 && lapDist > 0
              ? Math.round((lapDist / avgSpd) * 3600 * 100) / 100
              : lapData.length * 0.5);

        laps.push({
          lapNumber: currentLapNumber,
          startIndex: lapStartIdx,
          endIndex: i,
          dataPoints: lapData.length,
          time: lapTime,
          maxSpeed: Math.max(...speeds),
          avgSpeed: avgSpd,
          maxG: Math.max(...gForces),
          distance: lapDist,
          sectors: analyzeSectors(lapData)
        });
      }

      currentLapNumber = lapNum;
      lapStartIdx = i;
    }
  }

  // Close final open lap
  // Cap endIndex at the last row where lap > 0 (ignore post-session cooldown rows with lap=0)
  if (currentLapNumber !== null) {
    let endIdx = data.length - 1;
    while (endIdx >= lapStartIdx && (data[endIdx].lap === null || data[endIdx].lap === 0)) {
      endIdx--;
    }
    const lapData = data.slice(lapStartIdx, endIdx + 1);
    if (lapData.length >= 10) {
      const firstTs = lapData[0].timestamp;
      const lastTs = lapData[lapData.length - 1].timestamp;
      const speeds = lapData.map(d => d.speed);
      const gForces = lapData.map(d => Math.abs(d.gforce));
      const lapDist = calculateDistance(lapData);
      const avgSpd = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      const lapTime = (firstTs && lastTs && lastTs > firstTs)
        ? Math.round((lastTs - firstTs) / 1000 * 100) / 100
        : (avgSpd > 1 && lapDist > 0
            ? Math.round((lapDist / avgSpd) * 3600 * 100) / 100
            : lapData.length * 0.5);

      if (lapTime < 300) {  // ignore laps > 5 min (session end artifacts)
        laps.push({
          lapNumber: currentLapNumber,
          startIndex: lapStartIdx,
          endIndex: endIdx + 1,
          dataPoints: lapData.length,
          time: lapTime,
          maxSpeed: Math.max(...speeds),
          avgSpeed: avgSpd,
          maxG: Math.max(...gForces),
          distance: lapDist,
          sectors: analyzeSectors(lapData)
        });
      }
    }
  }

  return laps;
}

/**
 * GPS-based lap detection (fallback for standard CSV formats)
 */
/**
 * GPS start/finish gate lap detection.
 * Derives a start/finish point from the fastest-moving on-track location, then
 * counts gate crossings. Works for flying-lap track sessions where the bike
 * never stops between laps (so the stop-based detector fails).
 */
function identifyLapsByGate(data) {
  const pts = data.filter(d => d.lat && d.lon && d.timestamp);
  if (pts.length < 200) return [];

  // Pick a gate: a point that is reliably crossed each lap. Use the location of
  // the first sustained high-speed sample (typically the main straight near S/F).
  // Fall back to the median on-track coordinate.
  const moving = pts.filter(d => d.speed > 40);
  const ref = moving.length > 50 ? moving[Math.floor(moving.length * 0.05)] : pts[Math.floor(pts.length / 2)];
  const gateLat = ref.lat, gateLon = ref.lon;
  const RADIUS = 30; // metres

  // Find crossings: entering the gate radius (rising edge)
  const crossings = [];
  let inside = false;
  for (let i = 0; i < pts.length; i++) {
    const d = haversine(pts[i].lat, pts[i].lon, gateLat, gateLon);
    if (d < RADIUS) {
      if (!inside) { crossings.push(i); inside = true; }
    } else {
      inside = false;
    }
  }

  const laps = [];
  let lapNumber = 1;
  for (let j = 1; j < crossings.length; j++) {
    const s = crossings[j - 1], e = crossings[j];
    const seg = pts.slice(s, e);
    const firstTs = seg[0].timestamp, lastTs = seg[seg.length - 1].timestamp;
    const lapTime = (firstTs && lastTs && lastTs > firstTs)
      ? Math.round((lastTs - firstTs) / 1000 * 100) / 100
      : seg.length * 0.04;
    // Plausible flying-lap window: 30s..5min, and a real moving lap
    if (lapTime < 30 || lapTime > 300) continue;
    const speeds = seg.map(d => d.speed);
    if (Math.max(...speeds) < 40) continue;
    const gForces = seg.map(d => Math.abs(d.gforce));
    laps.push({
      lapNumber: lapNumber++,
      startIndex: s,
      endIndex: e,
      dataPoints: seg.length,
      time: lapTime,
      maxSpeed: Math.max(...speeds),
      avgSpeed: speeds.reduce((a, b) => a + b, 0) / speeds.length,
      maxG: Math.max(...gForces),
      distance: calculateDistance(seg),
      sectors: analyzeSectors(seg)
    });
  }
  return laps;
}

function identifyLapsByGPS(data) {
  if (data.length < 100) return [];

  const laps = [];
  let lapStartIdx = 0;
  let inLap = false;
  let lapNumber = 1;
  const MIN_LAP_POINTS = 15;
  const MIN_LAP_TIME_S = 15;

  // Phase 1: find first lap start
  for (let i = 1; i < data.length; i++) {
    if (data[i].speed > 1 && data[i - 1].speed <= 1) {
      lapStartIdx = i;
      inLap = true;
      break;
    }
  }

  let consecutiveSlow = 0;

  for (let i = lapStartIdx + 1; i < data.length; i++) {
    const isSlow = data[i].speed < 2;

    if (isSlow) consecutiveSlow++;
    else consecutiveSlow = 0;

    if (inLap && consecutiveSlow >= 3) {
      const lapEndIdx = i - 2;
      const lapData = data.slice(lapStartIdx, lapEndIdx);

      if (lapData.length >= MIN_LAP_POINTS) {
        const firstTs = lapData[0].timestamp;
        const lastTs = lapData[lapData.length - 1].timestamp;
        const lapTime = (firstTs && lastTs && lastTs > firstTs)
          ? Math.round((lastTs - firstTs) / 1000)
          : (lapEndIdx - lapStartIdx);

        if (lapTime >= MIN_LAP_TIME_S) {
          const speeds = lapData.map(d => d.speed);
          const gForces = lapData.map(d => Math.abs(d.gforce));
          laps.push({
            lapNumber: lapNumber++,
            startIndex: lapStartIdx,
            endIndex: lapEndIdx,
            dataPoints: lapData.length,
            time: lapTime,
            maxSpeed: Math.max(...speeds),
            avgSpeed: speeds.reduce((a, b) => a + b, 0) / speeds.length,
            maxG: Math.max(...gForces),
            distance: calculateDistance(lapData),
            sectors: analyzeSectors(lapData)
          });
        }
      }

      let nextStart = null;
      for (let j = i + 1; j < data.length - 5; j++) {
        if (data[j].speed > 3 && data[j - 1].speed <= 3) {
          nextStart = j;
          break;
        }
      }

      if (nextStart !== null) {
        lapStartIdx = nextStart;
        consecutiveSlow = 0;
      } else {
        inLap = false;
      }
    }
  }

  // Final open lap
  if (inLap) {
    const lapData = data.slice(lapStartIdx);
    if (lapData.length >= MIN_LAP_POINTS) {
      const firstTs = lapData[0].timestamp;
      const lastTs = lapData[lapData.length - 1].timestamp;
      const lapTime = (firstTs && lastTs && lastTs > firstTs)
        ? Math.round((lastTs - firstTs) / 1000)
        : (data.length - lapStartIdx);
      const speeds = lapData.map(d => d.speed);
      const gForces = lapData.map(d => Math.abs(d.gforce));
      laps.push({
        lapNumber: lapNumber,
        startIndex: lapStartIdx,
        endIndex: data.length,
        dataPoints: lapData.length,
        time: lapTime,
        maxSpeed: Math.max(...speeds),
        avgSpeed: speeds.reduce((a, b) => a + b, 0) / speeds.length,
        maxG: Math.max(...gForces),
        distance: calculateDistance(lapData),
        sectors: analyzeSectors(lapData)
      });
    }
  }

  return laps;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTOR ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze sectors (T1/T2/T3) for a lap
 */
function analyzeSectors(lapData) {
  const n = lapData.length;
  if (n < 30) return [];

  const sectorSize = Math.floor(n / 3);
  return [0, 1, 2].map(i => {
    const sectorData = lapData.slice(i * sectorSize, (i + 1) * sectorSize);
    if (sectorData.length === 0) return null;
    const speeds = sectorData.map(d => d.speed);
    const gForces = sectorData.map(d => Math.abs(d.gforce));
    return {
      sector: i + 1,
      maxSpeed: Math.max(...speeds),
      avgSpeed: speeds.reduce((a, b) => a + b, 0) / speeds.length,
      maxG: Math.max(...gForces)
    };
  }).filter(s => s !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// LAP STATS& IDEAL LAP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate lap statistics across all laps
 */
function calculateLapStats(laps) {
  if (laps.length === 0) return { count: 0, best: null, worst: null, average: null, spread: null, stdDev: null, consistency: null };

  const times = laps.map(l => l.time).sort((a, b) => a - b);
  const best = times[0];
  const worst = times[times.length - 1];
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const spread = worst - best;
  const stdDev = Math.round(Math.sqrt(times.map(t => Math.pow(t - avg, 2)).reduce((a, b) => a + b, 0) / times.length) * 100) / 100;

  return {
    count: laps.length,
    best,
    worst,
    average: Math.round(avg * 100) / 100,
    spread: Math.round(spread * 100) / 100,
    stdDev,
    consistency: spread < 3 ? 'Very High' : spread < 8 ? 'High' : spread < 15 ? 'Medium' : 'Low'
  };
}

/**
 * Find the ideal/best lap using a weighted score
 */
function findIdealLap(laps, data) {
  if (laps.length === 0) return null;

  const bestTime = Math.min(...laps.map(l => l.time));

  const scoredLaps = laps.map(lap => ({
    ...lap,
    score: (bestTime / lap.time) * 100 + (lap.avgSpeed / 200) * 50 + Math.max(0, 30 - lap.maxG * 10)
  }));

  const best = scoredLaps.reduce((a, b) => a.score > b.score ? a : b);

  return {
    lapNumber: best.lapNumber,
    time: best.time,
    maxSpeed: best.maxSpeed,
    avgSpeed: best.avgSpeed,
    maxG: best.maxG,
    score: Math.round(best.score),
    dataPoints: best.endIndex - best.startIndex,
    sectors: best.sectors || [],
    delta: Math.round((best.time - bestTime) * 1000) / 1000
  };
}

/**
 * Generate lap comparison table with delta from best
 */
function generateLapComparison(laps) {
  if (laps.length === 0) return [];
  const bestTime = Math.min(...laps.map(l => l.time));
  return laps.map(lap => ({
    lapNumber: lap.lapNumber,
    time: lap.time,
    delta: Math.round((lap.time - bestTime) * 1000) / 1000,
    deltaPercent: laps.length > 1 ? Math.round(((lap.time - bestTime) / bestTime) * 10000) / 100 : 0,
    maxSpeed: Math.round(lap.maxSpeed),
    avgSpeed: Math.round(lap.avgSpeed),
    maxG: Math.round(lap.maxG * 10) / 10,
    distance: Math.round(lap.distance * 100) / 100
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// VISUALIZATIONS
// ─────────────────────────────────────────────────────────────────────────────

function generateAllVisualizations(data, laps) {
  return {
    speedTrace: generateSpeedTrace(data),
    gForceTrace: generateGForceTrace(data),
    lapComparison: generateLapComparisonChart(laps),
    speedDistribution: generateSpeedDistribution(data),
    gForceDistribution: generateGForceDistribution(data),
    sectorComparison: generateSectorComparison(laps),
    trackMap: generateTrackMap(data, laps)
  };
}

/**
 * Build a speed-colored GPS racing-line for the track map.
 * Projects lat/lon to a local planar XY (equirectangular around the centroid),
 * downsamples to a sane number of points, and tags each point with speed so the
 * renderer can color the line (slow = cool, fast = hot). Uses the single best
 * lap's GPS window when we can isolate it, otherwise the whole session.
 * Returns null when there isn't usable GPS.
 */
function generateTrackMap(data, laps) {
  const pts = (data || []).filter(p => isFinite(p.lat) && isFinite(p.lon) && (p.lat !== 0 || p.lon !== 0));
  if (pts.length < 20) return null;

  // Prefer the fastest lap's slice for a clean single-lap outline when lap
  // boundaries carry point indices; otherwise fall back to the full session.
  let slice = pts;
  try {
    const timed = (laps || []).filter(l => (l.time ?? l.lapTime) > 0);
    if (timed.length) {
      const best = timed.reduce((a, b) => ((a.time ?? a.lapTime) <= (b.time ?? b.lapTime) ? a : b));
      if (Number.isFinite(best.startIndex) && Number.isFinite(best.endIndex) && best.endIndex > best.startIndex) {
        const s = pts.filter(p => p.index >= best.startIndex && p.index <= best.endIndex);
        if (s.length >= 20) slice = s;
      }
    }
  } catch (_) { /* fall back to full session */ }

  // Equirectangular projection around centroid (good enough at track scale).
  const toRad = d => (d * Math.PI) / 180;
  const latC = slice.reduce((s, p) => s + p.lat, 0) / slice.length;
  const lonC = slice.reduce((s, p) => s + p.lon, 0) / slice.length;
  const R = 6371000;
  const cosLat = Math.cos(toRad(latC));
  let raw = slice.map(p => ({
    x: R * toRad(p.lon - lonC) * cosLat,
    y: R * toRad(p.lat - latC),
    speed: p.speed || 0
  }));

  // Downsample to ~600 points for a light payload but smooth curve.
  const MAX = 600;
  if (raw.length > MAX) {
    const step = raw.length / MAX;
    const ds = [];
    for (let i = 0; i < raw.length; i += step) ds.push(raw[Math.floor(i)]);
    raw = ds;
  }

  // Normalize into a 0..1000 box, preserving aspect ratio, y-up.
  const xs = raw.map(p => p.x), ys = raw.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1;
  const span = Math.max(spanX, spanY);
  const padX = (span - spanX) / 2, padY = (span - spanY) / 2;
  const speeds = raw.map(p => p.speed);
  const vMin = Math.min(...speeds), vMax = Math.max(...speeds) || 1;

  const path = raw.map(p => ({
    x: +(((p.x - minX + padX) / span) * 1000).toFixed(1),
    y: +(((p.y - minY + padY) / span) * 1000).toFixed(1),
    speed: Math.round(p.speed),
    // 0..1 speed intensity for the color ramp
    t: +(((p.speed - vMin) / ((vMax - vMin) || 1))).toFixed(3)
  }));

  return {
    path,
    center: { lat: +latC.toFixed(6), lon: +lonC.toFixed(6) },
    speedRange: { min: Math.round(vMin), max: Math.round(vMax) },
    scope: slice === pts ? 'session' : 'bestLap',
    points: path.length
  };
}

function generateSpeedTrace(data) {
  const step = Math.max(1, Math.floor(data.length / 200));
  return Array.from({ length: Math.floor(data.length / step) }, (_, i) => ({
    x: i * step,
    y: Math.round(data[i * step].speed)
  }));
}

function generateGForceTrace(data) {
  const step = Math.max(1, Math.floor(data.length / 200));
  return Array.from({ length: Math.floor(data.length / step) }, (_, i) => ({
    x: i * step,
    y: Math.round(data[i * step].gforce * 10) / 10
  }));
}

function generateLapComparisonChart(laps) {
  if (laps.length === 0) return [];
  const bestTime = Math.min(...laps.map(l => l.time));
  return laps.map(lap => ({
    x: `Lap ${lap.lapNumber}`,
    y: lap.time,
    delta: lap.time - bestTime
  }));
}

function generateSpeedDistribution(data) {
  const buckets = [0, 50, 100, 150, 200, 250, 300, 350, 400];
  const counts = new Array(buckets.length - 1).fill(0);
  data.forEach(d => {
    const s = d.speed;
    for (let i = 0; i < buckets.length - 1; i++) {
      if (s >= buckets[i] && s < buckets[i + 1]) { counts[i]++; break; }
    }
  });
  return buckets.slice(0, -1).map((b, i) => ({ range: `${b}-${buckets[i + 1]}`, count: counts[i] }));
}

function generateGForceDistribution(data) {
  const buckets = [-2, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5];
  const counts = new Array(buckets.length - 1).fill(0);
  data.forEach(d => {
    const g = d.gforce;
    for (let i = 0; i < buckets.length - 1; i++) {
      if (g >= buckets[i] && g < buckets[i + 1]) { counts[i]++; break; }
    }
  });
  return buckets.slice(0, -1).map((b, i) => ({ range: `${b}g to ${buckets[i + 1]}g`, count: counts[i] }));
}

function generateSectorComparison(laps) {
  if (laps.length === 0) return [];
  const sectorData = { 1: [], 2: [], 3: [] };
  laps.forEach(lap => {
    if (lap.sectors) {
      lap.sectors.forEach(s => {
        if (sectorData[s.sector]) {
          sectorData[s.sector].push({ lap: lap.lapNumber, avgSpeed: s.avgSpeed, maxSpeed: s.maxSpeed });
        }
      });
    }
  });
  return Object.entries(sectorData).map(([sector, sdata]) => ({
    sector: parseInt(sector),
    avgSpeed: sdata.length > 0 ? Math.round(sdata.reduce((a, b) => a + b.avgSpeed, 0) / sdata.length) : 0,
    lapData: sdata
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// TRACK DETECTION
// ─────────────────────────────────────────────────────────────────────────────

// Canonical track-name aliases so multi-rider RaceBox exports (which may label the
// Track field differently per rider, or leave it blank) all resolve to ONE name.
const TRACK_ALIASES = {
  'Canadian Tire Motorsport Park': [
    'mosport', 'ctmp', 'canadian tire', 'canadian tire motorsport', 'canadian tire motorsport park',
    'mosport park', 'mosport international', 'mosport international raceway', 'bowmanville', 'clarington'
  ],
  'Calabogie Motorsports Park': ['calabogie', 'calabogie motorsports', 'calabogie motorsports park'],
  'Shannonville': ['shannonville', 'shannonville motorsport park', 'smp'],
  'Toronto Motorsports Park': ['toronto motorsports park', 'tmp', 'cayuga'],
};

function canonicalizeTrackName(raw) {
  if (!raw) return null;
  const norm = String(raw).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  for (const [canon, aliases] of Object.entries(TRACK_ALIASES)) {
    if (norm === canon.toLowerCase()) return canon;
    if (aliases.some(a => norm === a || norm.includes(a))) return canon;
  }
  return raw; // unknown track: keep whatever the export said
}

function detectTrackFromMetadata(metadata) {
  if (metadata && metadata.track) return canonicalizeTrackName(metadata.track);
  return null;
}

function detectTrack(data) {
  const tracks = {
    'Canadian Tire Motorsport Park': { lat: 44.0500, lon: -78.6778, threshold: 3000 }, // CTMP/Mosport GP circuit (Clarington, ON) — official 44°03'00"N 78°40'40"W
    'Sebring': { lat: 27.4552, lon: -81.3428, threshold: 3000 },
    'Laguna Seca': { lat: 36.5889, lon: -121.8814, threshold: 2000 },
    'Watkins Glen': { lat: 42.3387, lon: -76.9217, threshold: 3000 },
    'Road America': { lat: 43.5723, lon: -87.8837, threshold: 3000 },
    'Toronto Motorsports Park': { lat: 43.8168, lon: -79.5317, threshold: 2000 },
    'Shannonville': { lat: 44.2250, lon: -77.1594, threshold: 2000 },
    'Calabogie Motorsports Park': { lat: 45.30278, lon: -76.67222, threshold: 3000 }
  };

  const lats = data.map(d => d.lat).filter(l => l !== 0).sort((a, b) => a - b);
  const lons = data.map(d => d.lon).filter(l => l !== 0).sort((a, b) => a - b);
  if (lats.length === 0) return null;

  const mid = Math.floor(lats.length / 2);
  const avgLat = lats[mid], avgLon = lons[mid];

  for (const [name, pos] of Object.entries(tracks)) {
    if (haversine(avgLat, avgLon, pos.lat, pos.lon) < pos.threshold) return name;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// METRICS
// ─────────────────────────────────────────────────────────────────────────────

function calculateDistance(data) {
  let dist = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i].lat && data[i - 1].lat) {
      dist += haversine(data[i - 1].lat, data[i - 1].lon, data[i].lat, data[i].lon);
    }
  }
  return Math.round(dist / 1000 * 100) / 100;
}

function calculateMetrics(data) {
  if (data.length === 0) {
    return { maxSpeed: 0, avgSpeed: 0, maxBraking: 0, maxCornering: 0, totalDistance: 0, sessionDuration: 0 };
  }

  const speeds = data.map(d => d.speed);
  const maxSpeed = Math.max(...speeds);

  // avg speed: exclude zero-speed (pitlane / out-lap) to get true on-track average
  const movingSpeeds = speeds.filter(s => s > 0);
  const avgSpeed = movingSpeeds.length > 0
    ? movingSpeeds.reduce((a, b) => a + b, 0) / movingSpeeds.length
    : 0;

  // max G: use the combined gforce column (peak total G experienced)
  // gLat/gLon from IMU lean-angle data do NOT represent G-force components in this format
  const gforces = data.map(d => d.gforce);
  const maxG = gforces.length > 0 ? Math.max(...gforces) : 0;

  // G-force split: gLon/gLat in RaceBox/MTB formats are lean angles (degrees), NOT G-force
  // components. The combined gforce column is the only reliable G measurement.
  // For cornering vs braking split we use the overall peak and a riding-style heuristic:
  // peak cornering G typically exceeds braking G by ~1.2-1.5x for sport riding.
  // Use 0.65 cornering / 0.35 braking as a realistic default for track riding.
  const maxBraking   = Math.round(maxG * 0.35 * 10) / 10;
  const maxCornering = Math.round(maxG * 0.65 * 10) / 10;

  let totalDistance = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i].lat && data[i - 1].lat) {
      totalDistance += haversine(data[i - 1].lat, data[i - 1].lon, data[i].lat, data[i].lon);
    }
  }

  const firstTs = data[0].timestamp;
  const lastTs = data[data.length - 1].timestamp;
  const sessionDuration = (firstTs && lastTs) ? Math.round((lastTs - firstTs) / 1000) : 0;

  return {
    maxSpeed,
    avgSpeed,
    maxG,           // overall peak G (most useful single number)
    maxBraking,
    maxCornering,
    totalDistance: Math.round(totalDistance / 1000 * 100) / 100,
    sessionDuration
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MATH UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) { return deg * Math.PI / 180; }

export default { analyzeCSV };
