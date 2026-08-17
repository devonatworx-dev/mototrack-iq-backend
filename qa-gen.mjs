import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = '/home/assistant/.openclaw/media/inbound';
const OUT = '/home/assistant/.openclaw/workspace/mototrackiq-reports';

async function main() {
  const { analyzeCSV } = await import('./lib/analyzer.js');
  const { generateReport } = await import('./lib/reportGenerator.js');

  const csv = fs.readFileSync(BASE+'/RaceBox_Track_Session_Dennis_Morning_Practice---29934e25-aebb-4711-a5a4-9156a5c82ced.csv','utf8').trim();
  const analysis = analyzeCSV(csv);
  analysis.riderId = 'dennis-test';
  analysis.uploadedAt = new Date().toISOString();

  const pdf = await generateReport(analysis, {
    riderName: 'Dennis Giannone',
    bikeName: 'Kawasaki Ninja 400'
  });

  fs.writeFileSync(OUT+'/Dennis_Morning_Practice_QA.pdf', pdf);
  console.log('Done:', pdf.length, 'bytes');
}

main().catch(e => { console.error(e.message); process.exit(1); });
