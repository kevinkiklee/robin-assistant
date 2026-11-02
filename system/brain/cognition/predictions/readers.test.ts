import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeDb, type RobinDb } from '../../memory/db.ts';
import { compactRegistry, describeRegistry, METRIC_REGISTRY } from './readers.ts';
import { readSpec } from './resolve-spec.ts';
import { type PredictionSpec, specAtEndMs, validateSpec } from './spec.ts';
import { addEvent, addRecovery, freshDb } from './test-helpers.ts';

/** Validate + read a spec at its `at`; null = no trustworthy reading. */
function read(db: RobinDb, spec: Omit<PredictionSpec, 'op' | 'threshold'>): number | null {
  const v = validateSpec({ op: '>=', threshold: 0, ...spec });
  assert.ok(v.ok, v.ok ? '' : v.error);
  return readSpec(db, v.spec, v.metric, specAtEndMs(v.spec.at) as number)?.value ?? null;
}

test('whoop: recovery value = latest finalized morning as of `at`; provisional + later days ignored', () => {
  const db = freshDb();
  addRecovery(db, '2026-10-04', 41);
  addRecovery(db, '2026-10-05', 55);
  addRecovery(db, '2026-10-06', 99, { provisional: true, external_id: 'whoop:recovery:p' });
  addRecovery(db, '2026-10-07', 70); // after `at`
  assert.equal(read(db, { source: 'whoop', metric: 'recovery_score', at: '2026-10-06' }), 55);
  assert.equal(read(db, { source: 'whoop', metric: 'rhr', at: '2026-10-05' }), 50);
  assert.equal(read(db, { source: 'whoop', metric: 'hrv', at: '2026-10-05' }), 70);
  closeDb(db);
});

test('whoop: re-synced rows dedupe by external_id (latest ingest wins)', () => {
  const db = freshDb();
  addRecovery(db, '2026-10-05', 30);
  addRecovery(db, '2026-10-05', 62); // same external_id, re-scored
  assert.equal(read(db, { source: 'whoop', metric: 'recovery_score', at: '2026-10-05' }), 62);
  closeDb(db);
});

test('whoop: stale stream → null (a dead band never resolves a prediction)', () => {
  const db = freshDb();
  addRecovery(db, '2026-09-20', 60);
  assert.equal(read(db, { source: 'whoop', metric: 'recovery_score', at: '2026-10-06' }), null);
  closeDb(db);
});

test('whoop: windowed aggregates over window_days ending at `at`', () => {
  const db = freshDb();
  for (const [d, v] of [
    ['2026-09-28', 90], // outside a 7d window ending 10-06
    ['2026-09-30', 40],
    ['2026-10-02', 50],
    ['2026-10-06', 60],
  ] as const) {
    addRecovery(db, d, v);
  }
  const base = { source: 'whoop', metric: 'recovery_score', at: '2026-10-06', window_days: 7 };
  assert.equal(read(db, { ...base, agg: 'mean' }), 50);
  assert.equal(read(db, { ...base, agg: 'max' }), 60);
  assert.equal(read(db, { ...base, agg: 'min' }), 40);
  closeDb(db);
});

test('whoop: sleep metrics skip naps; strain skips the in-progress cycle', () => {
  const db = freshDb();
  const sleep = (id: string, end: string, nap: boolean, perf: number) =>
    addEvent(db, 'whoop.sleep', end, {
      external_id: `whoop:sleep:${id}`,
      score_state: 'SCORED',
      nap,
      end,
      score: {
        sleep_performance_percentage: perf,
        sleep_efficiency_percentage: 88,
        stage_summary: {
          total_in_bed_time_milli: 8 * 3_600_000,
          total_awake_time_milli: 3_600_000,
        },
      },
    });
  sleep('n', '2026-10-05T11:00:00.000Z', false, 71);
  sleep('nap', '2026-10-05T19:00:00.000Z', true, 100);
  assert.equal(read(db, { source: 'whoop', metric: 'sleep_performance', at: '2026-10-05' }), 71);
  assert.equal(read(db, { source: 'whoop', metric: 'sleep_hours', at: '2026-10-05' }), 7);

  const cycle = (id: string, start: string, end: string | null, strain: number) =>
    addEvent(db, 'whoop.cycle', start, {
      external_id: `whoop:cycle:${id}`,
      score_state: 'SCORED',
      start,
      end,
      score: { strain },
    });
  cycle('1', '2026-10-04T03:00:00.000Z', '2026-10-05T02:00:00.000Z', 12.5);
  cycle('2', '2026-10-05T02:00:00.000Z', null, 0.8);
  assert.equal(read(db, { source: 'whoop', metric: 'strain', at: '2026-10-05' }), 12.5);
  closeDb(db);
});

test('whoop: workouts counts by sport in the window; needs a live whoop stream', () => {
  const db = freshDb();
  const spec = {
    source: 'whoop',
    metric: 'workouts',
    key: 'weightlifting',
    at: '2026-10-06',
    window_days: 7,
  };
  assert.equal(read(db, spec), null, 'no whoop stream at all → no reading');
  addRecovery(db, '2026-10-06', 50);
  const wo = (id: string, start: string, sport: string) =>
    addEvent(db, 'whoop.workout', start, { external_id: `w:${id}`, start, sport_name: sport });
  wo('a', '2026-10-01T22:00:00.000Z', 'weightlifting');
  wo('b', '2026-10-03T22:00:00.000Z', 'walking');
  wo('c', '2026-09-20T22:00:00.000Z', 'weightlifting'); // outside the window
  assert.equal(read(db, spec), 1);
  assert.equal(read(db, { ...spec, key: undefined }), 2);
  closeDb(db);
});

function snap(db: RobinDb, day: string, id: number, name: string, type: string, balance: number) {
  addEvent(
    db,
    'lunch_money.account_snapshot',
    `${day}T10:00:00.000Z`,
    {
      external_id: `snap:${id}:${day}`,
      lm_id: id,
      display_name: name,
      type,
      balance,
      snapshot_date: day,
      stale: false,
    },
    'lunch_money_account_snapshot',
  );
}

test('finance: balance by unique name; ambiguous or unknown key → null', () => {
  const db = freshDb();
  snap(db, '2026-10-05', 1, 'Lakeport Credit Union Savings', 'depository', 3_100);
  snap(db, '2026-10-05', 2, 'Bank Checking', 'depository', 5000);
  snap(db, '2026-10-05', 3, 'Bank Card A', 'credit', 270);
  const at = '2026-10-05';
  assert.equal(read(db, { source: 'finance', metric: 'balance', key: 'lakeport', at }), 3_100);
  assert.equal(read(db, { source: 'finance', metric: 'balance', key: 'bank card a', at }), 270);
  assert.equal(read(db, { source: 'finance', metric: 'balance', key: 'Bank', at }), null);
  assert.equal(read(db, { source: 'finance', metric: 'balance', key: 'Zenith', at }), null);
  closeDb(db);
});

test('finance: net_worth nets liabilities and skips partial snapshot days; cash = depository', () => {
  const db = freshDb();
  snap(db, '2026-10-04', 1, 'Savings', 'depository', 10_000);
  snap(db, '2026-10-04', 2, 'Card', 'credit', 1_000);
  snap(db, '2026-10-04', 3, '401k', 'investment', 50_000);
  snap(db, '2026-10-05', 1, 'Savings', 'depository', 11_000); // card + 401k missing → partial
  const at = '2026-10-05';
  assert.equal(read(db, { source: 'finance', metric: 'net_worth', at }), 59_000);
  assert.equal(read(db, { source: 'finance', metric: 'cash', at: '2026-10-04' }), 10_000);
  closeDb(db);
});

test('finance: a Plaid-lagged (stale) account is dated by balance_last_update, but still counted in sums', () => {
  const db = freshDb();
  snap(db, '2026-10-05', 1, 'Checking', 'depository', 5_000);
  addEvent(
    db,
    'lunch_money.account_snapshot',
    '2026-10-05T10:00:00.000Z',
    {
      external_id: 'snap:2:2026-10-05',
      lm_id: 2,
      display_name: 'Lakeport Credit Union Savings',
      type: 'depository',
      balance: 4_250,
      snapshot_date: '2026-10-05',
      stale: true,
      balance_last_update: '2026-09-10T16:00:00.000Z',
    },
    'lunch_money_account_snapshot',
  );
  const at = '2026-10-05';
  assert.equal(read(db, { source: 'finance', metric: 'balance', key: 'Lakeport', at }), null);
  assert.equal(
    read(db, { source: 'finance', metric: 'balance', key: 'Lakeport', at: '2026-09-11' }),
    null,
    'snapshot rows only exist from 10-05 on',
  );
  assert.equal(read(db, { source: 'finance', metric: 'cash', at }), 9_250);
  closeDb(db);
});

test('finance: spend_per_day excludes income, transfers and card payments', () => {
  const db = freshDb();
  const tx = (id: string, date: string, amount: number, extra: Record<string, unknown> = {}) =>
    addEvent(db, 'lunch_money.transaction', `${date}T15:00:00.000Z`, {
      external_id: `tx:${id}`,
      date,
      amount,
      is_income: false,
      payee: 'Shop',
      category: 'Shopping',
      ...extra,
    });
  tx('1', '2026-10-04', 100);
  tx('2', '2026-10-04', 50);
  tx('3', '2026-10-05', 300);
  tx('4', '2026-10-05', 5000, { payee: 'Payment to card ending in 0000' });
  tx('5', '2026-10-05', 900, { category: 'Transfer' });
  tx('6', '2026-10-05', 2000, { is_income: true });
  const base = { source: 'finance', metric: 'spend_per_day', at: '2026-10-05', window_days: 7 };
  assert.equal(read(db, { ...base, agg: 'mean' }), 225);
  assert.equal(read(db, { ...base, agg: 'sum' }), 450);
  closeDb(db);
});

test('finance: quote_price reads the symbol tick', () => {
  const db = freshDb();
  addEvent(db, 'integration.finance_quote.tick', '2026-10-05T14:00:00.000Z', {
    symbol: 'ACME',
    price: 12.5,
    change_pct: 1.6,
  });
  const at = '2026-10-05';
  assert.equal(read(db, { source: 'finance', metric: 'quote_price', key: 'acme', at }), 12.5);
  assert.equal(read(db, { source: 'finance', metric: 'quote_price', key: 'QQQ', at }), null);
  closeDb(db);
});

test('photos: totals, gross frames added, critique counts', () => {
  const db = freshDb();
  const summary = (day: string, total: number) =>
    addEvent(db, 'lrc.catalog_summary', `${day}T08:00:00.000Z`, {
      total_photos: total,
      last_import_date: '2026-10-02T15:00:00.000',
      ratings: { '5': 12 },
    });
  summary('2026-09-28', 1000); // anchor before the window
  summary('2026-10-01', 1200); // +200
  summary('2026-10-03', 1150); // cull — ignored
  summary('2026-10-05', 1400); // +250
  const at = '2026-10-05';
  assert.equal(read(db, { source: 'photos', metric: 'total_photos', at }), 1400);
  assert.equal(read(db, { source: 'photos', metric: 'rated_count', key: '5', at }), 12);
  assert.equal(read(db, { source: 'photos', metric: 'days_since_import', at }), 2);
  assert.equal(
    read(db, { source: 'photos', metric: 'frames_added', at, window_days: 6 }),
    450,
    'gross positive deltas only',
  );
  addEvent(db, 'photos.critique', '2026-10-04T07:00:00.000Z', {}, 'photos-critique');
  addEvent(db, 'photos.critique', '2026-09-01T07:00:00.000Z', {}, 'photos-critique');
  assert.equal(read(db, { source: 'photos', metric: 'critiques', at, window_days: 7 }), 1);
  closeDb(db);
});

test('linear: state as of `at` from change events; later changes unseen; unknown issue → null', () => {
  const db = freshDb();
  const issue = (id: string, state: string, type: string, updatedAt: string) =>
    addEvent(db, 'integration.linear.issue', updatedAt, {
      identifier: id,
      state,
      state_type: type,
      team: 'ENG',
      updatedAt,
    });
  issue('ENG-12', 'Backlog', 'backlog', '2026-06-01T00:00:00.000Z');
  issue('ENG-12', 'Done', 'completed', '2026-06-20T00:00:00.000Z');
  issue('ENG-13', 'In Progress', 'started', '2026-06-02T00:00:00.000Z');
  const at = '2026-06-19';
  assert.equal(read(db, { source: 'linear', metric: 'issue_in_backlog', key: 'eng-12', at }), 1);
  assert.equal(
    read(db, { source: 'linear', metric: 'issue_open', key: 'ENG-12', at: '2026-06-20' }),
    0,
  );
  assert.equal(read(db, { source: 'linear', metric: 'open_issues', at }), 2);
  assert.equal(read(db, { source: 'linear', metric: 'state_count', key: 'in progress', at }), 1);
  assert.equal(read(db, { source: 'linear', metric: 'issue_open', key: 'ENG-99', at }), null);
  closeDb(db);
});

test('registry: catalog renders every metric; compact form flags keys/windows/states', () => {
  const full = describeRegistry();
  const compact = compactRegistry();
  for (const [source, metrics] of Object.entries(METRIC_REGISTRY)) {
    for (const name of Object.keys(metrics)) assert.ok(full.includes(`${source}.${name}`));
  }
  assert.match(compact, /balance\(key\)/);
  assert.match(compact, /workouts~/);
  assert.match(compact, /issue_open\(key\)@/);
});
