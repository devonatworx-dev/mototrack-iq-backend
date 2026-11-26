import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDayProgress } from '../lib/dayReport.js';

function session({ id, name, at, best }) {
  return {
    id,
    name,
    date: '2026-07-04',
    createdAt: at,
    analysisData: {
      summary: { trackName: 'Shannonville', sessionDate: at },
      lapStats: { best, count: 3, consistency: '0.4s' },
      laps: [{ lap: 1, time: best, maxSpeed: 160, maxG: 1.1 }],
      metrics: { maxSpeed: 160, avgSpeed: 110, maxG: 1.1 },
    },
  };
}

test('day progress compares sessions in time order, including two afternoon sessions', () => {
  const progress = buildDayProgress([
    session({ id: 'late', name: 'Last stint', at: '2026-07-04T16:00:00-04:00', best: 91.2 }),
    session({ id: 'mid', name: 'Middle', at: '2026-07-04T14:30:00-04:00', best: 90.4 }),
    session({ id: 'early', name: 'Opener', at: '2026-07-04T13:00:00-04:00', best: 92.0 }),
  ]);

  const arc = progress.summary.throughTheDay;
  assert.deepEqual(arc.steps.map((step) => step.name), ['Opener', 'Middle', 'Last stint']);
  assert.equal(arc.steps[0].deltaFromPrevious, null);
  assert.ok(arc.steps[1].deltaFromPrevious < 0);
  assert.equal(arc.steps[1].faster, true);
  assert.ok(Math.abs(arc.steps[1].deltaFromPrevious - (90.4 - 92.0)) < 0.001);
  assert.ok(arc.steps[2].deltaFromPrevious > 0);
  assert.equal(arc.steps[2].faster, false);
  assert.equal(arc.improved, true);
  assert.ok(Math.abs(arc.delta - (92.0 - 91.2)) < 0.001);
  assert.equal(progress.summary.improvement, null);
  assert.equal(progress.sessionDetails[0].order, 1);
  assert.equal(progress.sessionDetails[2].id, 'late');
  assert.match(progress.notes[0].title, /first session to last/);
  assert.match(progress.notes.map((note) => note.title).join(' '), /Session 2 was/);
});
