// QA chart x-axis labels for Dennis's sessions
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE='/home/assistant/.openclaw/media/inbound';
const { analyzeCSV } = await import('./lib/analyzer.js');
const { renderLapComparisonChart } = await import('./lib/reportGenerator.js');

const csv = fs.readFileSync(BASE+'/RaceBox_Track_Session_Dennis_Morning_Practice---29934e25-aebb-4711-a5a4-9156a5c82ced.csv','utf8').trim();
const a = analyzeCSV(csv);
console.log('laps:', a.laps?.length);
console.log('first lap:', JSON.stringify(a.laps?.[0]).slice(0,200));

// Test the chart
const chart = await renderLapComparisonChart(a.laps, 800, 250);
console.log('chart done, len:', chart?.length);
if (chart) {
  fs.writeFileSync('/tmp/lapchart.png', Buffer.from(chart, 'base64'));
  console.log('saved to /tmp/lapchart.png');
}
