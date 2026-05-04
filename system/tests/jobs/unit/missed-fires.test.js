import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findMissedFires } from '../../../scripts/jobs/lib/missed-fires.js';

const HOUR = 60 * 60 * 1000;

function makeJob(name, schedule, opts = {}) {
  return [
    name,
    {
      frontmatter: {
        name,
        schedule,
        enabled: opts.enabled !== false,
      },
    },
  ];
}

function makeStates(entries) {
  return new Map(entries.map(([name, ts]) => [name, { last_run_at: ts }]));
}

describe('findMissedFires', () => {
  const now = new Date('2026-05-04T22:00:00Z'); // 22:00 UTC = 18:00 EDT

  test('returns nothing when all jobs ran within 1.5x interval', () => {
    const jobs = new Map([
      makeJob('hourly', '0 * * * *'),
      makeJob('daily', '0 4 * * *'),
    ]);
    const states = makeStates([
      ['hourly', new Date(now.getTime() - 30 * 60 * 1000).toISOString()], // 30m ago
      ['daily', new Date(now.getTime() - 20 * HOUR).toISOString()], // 20h ago
    ]);
    const missed = findMissedFires({ jobs, states, now });
    assert.deepEqual(missed, []);
  });

  test('flags daily job whose last run is 40h ago (past 1.5x interval)', () => {
    const jobs = new Map([makeJob('dream', '0 4 * * *')]);
    const states = makeStates([['dream', new Date(now.getTime() - 40 * HOUR).toISOString()]]);
    const missed = findMissedFires({ jobs, states, now });
    assert.equal(missed.length, 1);
    assert.equal(missed[0].name, 'dream');
    assert.ok(missed[0].elapsedMs > missed[0].expectedMs * 1.5);
  });

  test('flags hourly job whose last run is 3h ago', () => {
    const jobs = new Map([makeJob('sync-linear', '5 * * * *')]);
    const states = makeStates([['sync-linear', new Date(now.getTime() - 3 * HOUR).toISOString()]]);
    const missed = findMissedFires({ jobs, states, now });
    assert.equal(missed.length, 1);
    assert.equal(missed[0].name, 'sync-linear');
  });

  test('skips disabled jobs', () => {
    const jobs = new Map([makeJob('disabled', '0 4 * * *', { enabled: false })]);
    const states = makeStates([['disabled', new Date(now.getTime() - 40 * HOUR).toISOString()]]);
    assert.deepEqual(findMissedFires({ jobs, states, now }), []);
  });

  test('skips jobs with no schedule', () => {
    const jobs = new Map([['triggered', { frontmatter: { name: 'triggered', enabled: true } }]]);
    const states = makeStates([['triggered', new Date(now.getTime() - 99 * HOUR).toISOString()]]);
    assert.deepEqual(findMissedFires({ jobs, states, now }), []);
  });

  test('skips jobs with no prior run state', () => {
    const jobs = new Map([makeJob('never-ran', '0 4 * * *')]);
    const states = new Map();
    assert.deepEqual(findMissedFires({ jobs, states, now }), []);
  });

  test('respects excludeNames (e.g. self-exclusion of heartbeat)', () => {
    const jobs = new Map([
      makeJob('_robin-sync', '*/15 * * * *'),
      makeJob('dream', '0 4 * * *'),
    ]);
    const states = makeStates([
      ['_robin-sync', new Date(now.getTime() - 99 * HOUR).toISOString()],
      ['dream', new Date(now.getTime() - 40 * HOUR).toISOString()],
    ]);
    const missed = findMissedFires({ jobs, states, now, excludeNames: ['_robin-sync'] });
    assert.equal(missed.length, 1);
    assert.equal(missed[0].name, 'dream');
  });

  test('skips jobs with unparseable cron', () => {
    const jobs = new Map([makeJob('bad', 'not-a-cron')]);
    const states = makeStates([['bad', new Date(now.getTime() - 99 * HOUR).toISOString()]]);
    assert.deepEqual(findMissedFires({ jobs, states, now }), []);
  });

  test('plain object states (not Map) also work', () => {
    const jobs = new Map([makeJob('dream', '0 4 * * *')]);
    const states = { dream: { last_run_at: new Date(now.getTime() - 40 * HOUR).toISOString() } };
    const missed = findMissedFires({ jobs, states, now });
    assert.equal(missed.length, 1);
  });
});
