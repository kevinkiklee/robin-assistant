import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeDomainStats,
  computeTrend,
  shouldEmitRule,
  weekStartingISO,
} from '../../cognition/jobs/internal/meta-calibration-narrative.js';

test('computeDomainStats: brier + drift + accuracy + mean_confidence', () => {
  const preds = [
    { predicted_confidence: 0.9, correct: true },
    { predicted_confidence: 0.8, correct: false },
    { predicted_confidence: 0.6, correct: true },
    { predicted_confidence: 0.4, correct: false },
  ];
  const s = computeDomainStats(preds);
  // brier = ((0.9-1)^2 + (0.8-0)^2 + (0.6-1)^2 + (0.4-0)^2) / 4
  //       = (0.01 + 0.64 + 0.16 + 0.16) / 4 = 0.2425
  assert.ok(Math.abs(s.brier - 0.2425) < 1e-6);
  assert.equal(s.accuracy, 0.5);
  assert.ok(Math.abs(s.mean_confidence - 0.675) < 1e-6);
  assert.ok(Math.abs(s.drift - 0.175) < 1e-6);
  assert.equal(s.samples, 4);
});

test('computeDomainStats: empty -> null', () => {
  assert.equal(computeDomainStats([]), null);
});

test('computeTrend: worsening / improving / flat / new', () => {
  assert.equal(computeTrend(0.3, 0.2), 'worsening');
  assert.equal(computeTrend(0.2, 0.3), 'improving');
  assert.equal(computeTrend(0.2, 0.22), 'flat');
  assert.equal(computeTrend(0.2, null), 'new');
});

test('shouldEmitRule: drift over threshold for >= min_weeks consecutive -> true', () => {
  const cfg = { meta_narrative_rule_threshold: 0.15, meta_narrative_rule_min_weeks: 2 };
  // Two prior weeks all over threshold same sign -> emit.
  assert.equal(shouldEmitRule({ drift: 0.2 }, [{ drift: 0.18 }, { drift: 0.17 }], cfg), true);
  // Below threshold this week -> no emit.
  assert.equal(shouldEmitRule({ drift: 0.1 }, [{ drift: 0.18 }], cfg), false);
  // Sign flip breaks the streak.
  assert.equal(shouldEmitRule({ drift: 0.2 }, [{ drift: -0.18 }, { drift: 0.2 }], cfg), false);
});

test('weekStartingISO: returns Sunday 00:00 local for any date in the same week', () => {
  // 2026-05-10 is a Sunday. Pick a Sunday in local time at 07:00.
  const sunday = new Date(2026, 4, 10, 7, 0, 0); // local time constructor
  assert.equal(weekStartingISO(sunday), '2026-05-10');
  // Saturday 2026-05-16 local at 22:00 -> Sunday at the start of that week is 2026-05-10.
  const saturday = new Date(2026, 4, 16, 22, 0, 0);
  assert.equal(weekStartingISO(saturday), '2026-05-10');
});
