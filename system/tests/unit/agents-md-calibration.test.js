import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent, calibrationSection } from '../../src/install/agents-md.js';

test('robin-calibration block exists in agentsMdContent', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-calibration:start/);
  assert.match(md, /<!-- robin-calibration:end -->/);
});

test('robin-calibration — null calibration shows "No calibration data yet"', () => {
  const md = agentsMdContent({ calibration: null });
  assert.match(md, /No calibration data yet/);
});

test('robin-calibration — populated calibration renders percentages', () => {
  const calibration = {
    by_kind: {
      duration: { resolved: 10, correct: 7, accuracy: 0.7 },
      fact_recall: { resolved: 5, correct: 2, accuracy: 0.4 },
    },
    total_open: 3,
    last_computed_at: new Date('2026-05-10T04:00:00Z'),
  };
  const md = calibrationSection(calibration);
  assert.match(md, /duration: 70% accurate \(n=10\)/);
  assert.match(md, /fact_recall: 40% accurate \(n=5\)/);
  assert.match(md, /total_open: 3/);
  assert.match(md, /2026-05-10T04:00:00\.000Z/);
});

test('robin-calibration — mentions predict, resolve_prediction, list_open_predictions tool names', () => {
  const calibration = {
    by_kind: { duration: { resolved: 4, correct: 3, accuracy: 0.75 } },
    total_open: 1,
    last_computed_at: new Date('2026-05-10T04:00:00Z'),
  };
  const md = agentsMdContent({ calibration });
  assert.match(md, /`predict\(/);
  assert.match(md, /`resolve_prediction\(/);
  assert.match(md, /`list_open_predictions\(\)`/);
});
