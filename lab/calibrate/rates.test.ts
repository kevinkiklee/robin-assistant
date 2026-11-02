import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../system/brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../system/brain/memory/migrations/index.ts';

const SQL = readFileSync(join(import.meta.dirname, 'rates.sql'), 'utf8');
// Allowed string shapes in output: month keys, bucket labels, status/kind tokens.
const SAFE_STRING = /^(\d{4}-\d{2}|1|2|3|4-5|6\+|[a-z_]+(\.[a-z_]+)?)$/;

function statements(): { name: string; sql: string }[] {
  return SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const m = s.match(/^-- name: ([a-z_]+)/);
      assert.ok(m, `statement missing "-- name:" header:\n${s.slice(0, 80)}`);
      return { name: m[1], sql: s };
    });
}

test('rates.sql: every statement runs on the current schema and returns only aggregates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-rates-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  const ev = db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, ?, 'sim', 'ok', ?)`,
  );
  // Whole-table window: 2027-01-01 .. 2027-01-11 = 10 days.
  const sessionIds: number[] = [];
  for (const ts of [
    '2027-01-01T00:00:00.000Z',
    '2027-01-03T00:00:00.000Z',
    '2027-01-05T00:00:00.000Z',
  ]) {
    sessionIds.push(Number(ev.run(ts, 'session.captured', '{}').lastInsertRowid));
  }
  const topics = ['topic-a b', 'topic-a b', 'topic-a b', 'topic-c d', 'topic-e f', 'topic-e f'];
  topics.forEach((topic, i) => {
    ev.run(
      `2027-01-0${i + 2}T10:00:00.000Z`,
      'belief.update',
      JSON.stringify({ topic, claim: 'secret claim here' }),
    );
  });
  ev.run('2027-01-11T00:00:00.000Z', 'integration.tick', '{}');

  const bc = db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, source_event_id, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  bc.run('topic-a b', 'secret claim here', 'pending', sessionIds[0], '2027-01-02 00:00:00', null);
  bc.run(
    'topic-c d',
    'secret claim two',
    'promoted',
    null,
    '2027-01-02 00:00:00',
    '2027-01-04 00:00:00',
  );

  db.prepare(
    `INSERT INTO corrections (ts, what, correction) VALUES ('2027-01-06 00:00:00', 'secret what', 'secret fix')`,
  ).run();

  const results = new Map<string, Record<string, unknown>[]>();

  const names = new Set<string>();
  for (const { name, sql } of statements()) {
    names.add(name);
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    results.set(name, rows);
    for (const row of rows) {
      assert.equal(row.metric, name, `${name} row missing self-label`);
      for (const [col, v] of Object.entries(row)) {
        if (typeof v === 'string') {
          assert.match(v, SAFE_STRING, `${name}.${col} leaked a free-text value: ${v}`);
        } else {
          assert.ok(v === null || typeof v === 'number', `${name}.${col} has type ${typeof v}`);
        }
      }
    }
  }
  for (const required of [
    'window',
    'events_per_day_by_kind',
    'sessions_per_day',
    'corrections_per_month',
    'supersessions_per_topic',
    'candidate_status',
    'candidate_days_to_resolve',
    'filler_session_share',
  ]) {
    assert.ok(names.has(required), `missing metric ${required}`);
  }

  // Denominator is the WHOLE events window (10 days), not the filtered kind's span.
  assert.equal(results.get('sessions_per_day')?.[0].per_day, 0.3);
  const perKind = Object.fromEntries(
    (results.get('events_per_day_by_kind') ?? []).map((r) => [r.kind_prefix, r.per_day]),
  );
  assert.equal(perKind.integration, 0.1);
  assert.equal(perKind.belief, 0.6);
  // 3 sessions, 1 referenced by a candidate -> filler share 2/3.
  assert.equal(results.get('filler_session_share')?.[0].share, 0.667);
  const status = Object.fromEntries(
    (results.get('candidate_status') ?? []).map((r) => [r.status, r.n]),
  );
  assert.deepEqual(status, { pending: 1, promoted: 1 });
  assert.equal(results.get('candidate_days_to_resolve')?.[0].mean_days, 2);
  const buckets = Object.fromEntries(
    (results.get('supersessions_per_topic') ?? []).map((r) => [r.bucket, r.topics]),
  );
  assert.deepEqual(buckets, { '1': 1, '2': 1, '3': 1 });
  db.close();
});

test('rates.sql: empty DB yields NULL filler share, not 1.0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-rates-empty-'));
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  const sql = statements().find((s) => s.name === 'filler_session_share')?.sql ?? '';
  const rows = db.prepare(sql).all() as { share: number | null }[];
  assert.equal(rows[0].share, null);
  db.close();
});
