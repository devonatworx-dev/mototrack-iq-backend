import fs from 'fs';
import { analyzeCSV } from './lib/analyzer.js';
import { generateReport } from './lib/reportGenerator.js';

const csvPath = process.argv[2];
const out = process.argv[3] || 'demo-report.pdf';
const riderName = process.argv[4] || 'Dennis Radomski';
const bikeName = process.argv[5] || 'Yamaha YZF-R6';

const csv = fs.readFileSync(csvPath, 'utf8');
console.log('CSV loaded:', csvPath, csv.length, 'bytes');

const analysis = analyzeCSV(csv);
console.log('Analysis done. Keys:', Object.keys(analysis).join(', '));
try {
  console.log('Laps:', analysis.laps?.length, '| Best:', analysis.lapStats?.bestLap ?? analysis.bestLap);
} catch {}

const pdf = await generateReport(analysis, { riderName, bikeName });
fs.writeFileSync(out, pdf);
console.log('PDF written:', out, pdf.length, 'bytes');
