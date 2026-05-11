import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache } from '../../io/integrations/_auth/token-cache.js';
import { sync } from '../../io/integrations/whoop/sync.js';

function ok(json) {
  return { ok: true, json: async () => json };
}

function makeFetchFn({
  recoveryRecords = [],
  sleepRecords = [],
  workoutRecords = [],
  cycleRecords = [],
  recoveryNextToken = null,
} = {}) {
  return mock.fn(async (url) => {
    if (url.includes('/oauth/oauth2/token')) {
      return ok({ access_token: 'a', expires_in: 3600 });
    }
    // Distinguish endpoints: '/recovery' is unique; '/cycle' must not match
    // '/recovery' (the latter does not include '/cycle' as a substring, good).
    if (url.includes('/recovery')) {
      const u = new URL(url);
      if (u.searchParams.get('nextToken')) {
        return ok({ records: [], next_token: null });
      }
      return ok({ records: recoveryRecords, next_token: recoveryNextToken });
    }
    if (url.includes('/activity/sleep')) {
      return ok({ records: sleepRecords, next_token: null });
    }
    if (url.includes('/activity/workout')) {
      return ok({ records: workoutRecords, next_token: null });
    }
    if (url.includes('/cycle')) {
      return ok({ records: cycleRecords, next_token: null });
    }
    throw new Error(`unexpected: ${url}`);
  });
}

const SECRETS = {
  WHOOP_REFRESH_TOKEN: 'r',
  WHOOP_CLIENT_ID: 'c',
  WHOOP_CLIENT_SECRET: 's',
};

test('whoop sync captures all four kinds and stamps cursor', async () => {
  _resetCache('whoop');
  const fetchFn = makeFetchFn({
    recoveryRecords: [
      {
        cycle_id: 'r1',
        score: { recovery_score: 70, hrv_rmssd_milli: 50, resting_heart_rate: 55 },
        created_at: '2026-05-10T08:00:00Z',
      },
    ],
    sleepRecords: [
      {
        id: 's1',
        score: {
          sleep_efficiency_percentage: 90,
          stage_summary: { total_in_bed_time_milli: 28_800_000 },
        },
        start: '2026-05-10T00:00:00Z',
      },
    ],
    workoutRecords: [
      {
        id: 'w1',
        sport_id: 1,
        start: '2026-05-10T17:00:00Z',
        end: '2026-05-10T18:00:00Z',
        score: { strain: 12 },
      },
    ],
    cycleRecords: [
      {
        id: 'c1',
        start: '2026-05-10T04:00:00Z',
        end: '2026-05-11T04:00:00Z',
        score: { strain: 10 },
      },
    ],
  });
  const captured = [];
  const r = await sync({
    secrets: SECRETS,
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 4);
  const kinds = captured.map((e) => e.meta.kind).sort();
  assert.deepEqual(kinds, ['cycle', 'recovery', 'sleep', 'workout']);
  // Cursor stamps for each kind.
  assert.ok(r.cursor.recovery);
  assert.ok(r.cursor.sleep);
  assert.ok(r.cursor.workout);
  assert.ok(r.cursor.cycle);
  // External IDs are namespaced.
  const ids = captured.map((e) => e.external_id).sort();
  assert.deepEqual(ids, [
    'whoop:cycle:c1',
    'whoop:recovery:r1',
    'whoop:sleep:s1',
    'whoop:workout:w1',
  ]);
});

test('whoop sync paginates when next_token returned', async () => {
  _resetCache('whoop');
  let recoveryCalls = 0;
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/oauth/oauth2/token')) {
      return ok({ access_token: 'a', expires_in: 3600 });
    }
    if (url.includes('/recovery')) {
      recoveryCalls += 1;
      if (recoveryCalls === 1) {
        return ok({
          records: [
            { cycle_id: 'r1', score: { recovery_score: 50 }, created_at: '2026-05-10T07:00:00Z' },
          ],
          next_token: 'page2',
        });
      }
      return ok({
        records: [
          { cycle_id: 'r2', score: { recovery_score: 60 }, created_at: '2026-05-10T08:00:00Z' },
        ],
        next_token: null,
      });
    }
    if (url.includes('/activity/sleep')) return ok({ records: [], next_token: null });
    if (url.includes('/activity/workout')) return ok({ records: [], next_token: null });
    if (url.includes('/cycle')) return ok({ records: [], next_token: null });
    throw new Error(`unexpected: ${url}`);
  });
  const captured = [];
  const r = await sync({
    secrets: SECRETS,
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 2);
  assert.equal(recoveryCalls, 2);
  assert.deepEqual(captured.map((e) => e.external_id).sort(), [
    'whoop:recovery:r1',
    'whoop:recovery:r2',
  ]);
});

test('whoop sync surfaces non-OK responses as errors', async () => {
  _resetCache('whoop');
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/oauth/oauth2/token')) {
      return ok({ access_token: 'a', expires_in: 3600 });
    }
    return { ok: false, status: 500, text: async () => 'boom' };
  });
  await assert.rejects(
    sync({
      secrets: SECRETS,
      log: () => {},
      cursor: null,
      capture: async () => ({}),
      fetchFn,
    }),
    /500/,
  );
});

test('recovery content includes formatted score, hrv, rhr', async () => {
  _resetCache('whoop');
  const fetchFn = makeFetchFn({
    recoveryRecords: [
      {
        cycle_id: 'r1',
        score: { recovery_score: 88, hrv_rmssd_milli: 64, resting_heart_rate: 52 },
        created_at: '2026-05-10T08:00:00Z',
      },
    ],
  });
  const captured = [];
  await sync({
    secrets: SECRETS,
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  const recovery = captured.find((e) => e.meta.kind === 'recovery');
  assert.ok(recovery);
  assert.match(recovery.content, /88%/);
  assert.match(recovery.content, /HRV 64ms/);
  assert.match(recovery.content, /RHR 52/);
});
