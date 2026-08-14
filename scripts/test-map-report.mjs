import fs from 'fs';
import { analyzeCSV } from '../lib/analyzer.js';
import { generateReport } from '../lib/reportGenerator.js';

const F = '/home/assistant/.openclaw/media/inbound/RaceBox_Track_Session_on_14-08-2026_16-19---f885f4ea-0e49-4840-91bf-c2af993cc38d.csv';
const csv = fs.readFileSync(F, 'utf-8');

const a = analyzeCSV(csv);
console.log('track:', a.summary.trackName, '| laps:', a.summary.lapCount);
const tm = a.visualizations.trackMap;
console.log('trackMap:', tm ? `points=${tm.points} scope=${tm.scope} speedRange=${tm.speedRange.min}-${tm.speedRange.max} center=${tm.center.lat},${tm.center.lon}` : 'NULL');
console.log('\n=== COACHING (' + a.coaching.notes.length + ' notes) ===');
console.log(a.coaching.summary);
for (const n of a.coaching.notes) console.log(` • ${n.title}: ${n.text.slice(0,150)}...`);

const buf = await generateReport(a, { riderName: 'Dennis Radomski', bikeName: '', outputPath: null });
const out = '/tmp/dennis-report.pdf';
// generateReport returns a Buffer when outputPath is null? check
if (Buffer.isBuffer(buf)) { fs.writeFileSync(out, buf); }
else { console.log('generateReport returned:', typeof buf, buf && Object.keys(buf)); }
try { console.log('\nPDF bytes:', fs.statSync(out).size); } catch(e){ console.log('no pdf file:', e.message); }
