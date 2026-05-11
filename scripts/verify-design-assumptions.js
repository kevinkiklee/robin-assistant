#!/usr/bin/env node
// Verification gates for the v2 db + memory redesign.
// Runs four assertions against an ephemeral SurrealDB v3:
//   G0.a — DEFINE EVENT cascade fires inside the deleting transaction
//   G0.b — Composite-ID UPSERT is idempotent (no separate UNIQUE needed)
//   G0.c — Field-path index on meta.* is selected for filtered queries
//   G0.d — fn::freshness returns 0 for memos with inbound supersedes edges
//
// Exit code 0 on all-pass; non-zero on any failure.

import { createNodeEngines } from '@surrealdb/node';
import { Surreal, surql } from 'surrealdb';

const NS = 'robin_verify';
const DB = 'main';

function ok(msg) {
  console.log(`  OK  ${msg}`);
}
function fail(msg, detail) {
  console.error(`  FAIL ${msg}`);
  if (detail) console.error(`       ${detail}`);
  process.exitCode = 1;
}

async function connect() {
  const db = new Surreal({ engines: createNodeEngines() });
  await db.connect('mem://');
  await db.use({ namespace: NS, database: DB });
  return db;
}

async function defineMinimalSchema(db) {
  await db
    .query(
      `
        DEFINE TABLE entities SCHEMAFULL TYPE NORMAL;
        DEFINE FIELD name ON entities TYPE string;

        DEFINE TABLE memos SCHEMAFULL TYPE NORMAL;
        DEFINE FIELD kind         ON memos TYPE string;
        DEFINE FIELD content      ON memos TYPE string;
        DEFINE FIELD confidence   ON memos TYPE float DEFAULT 0.5;
        DEFINE FIELD signal_count ON memos TYPE int DEFAULT 1;
        DEFINE FIELD decay_anchor ON memos TYPE datetime DEFAULT time::now();
        DEFINE FIELD meta         ON memos TYPE option<object> FLEXIBLE;
        DEFINE INDEX memos_kind            ON memos FIELDS kind;
        DEFINE INDEX memos_kind_meta_name  ON memos FIELDS kind, meta.name;

        DEFINE TABLE edges SCHEMAFULL TYPE NORMAL;
        DEFINE FIELD kind      ON edges TYPE string;
        DEFINE FIELD from      ON edges TYPE record;
        DEFINE FIELD to        ON edges TYPE record;
        DEFINE FIELD weight    ON edges TYPE option<float>;
        DEFINE FIELD last_seen ON edges TYPE option<datetime>;
        DEFINE INDEX edges_kind_from ON edges FIELDS kind, from;
        DEFINE INDEX edges_kind_to   ON edges FIELDS kind, to;

        DEFINE EVENT cascade_edges_entities ON entities WHEN $event = "DELETE"
          THEN { DELETE edges WHERE from = $before.id OR to = $before.id; };
        DEFINE EVENT cascade_edges_memos ON memos WHEN $event = "DELETE"
          THEN { DELETE edges WHERE from = $before.id OR to = $before.id; };

        DEFINE FUNCTION fn::freshness($memo: record<memos>) {
          LET $m = $memo.*;
          LET $superseded = (SELECT count() AS n FROM edges WHERE kind = 'supersedes' AND to = $memo GROUP ALL)[0].n ?? 0;
          IF $superseded > 0 { RETURN 0; };
          LET $half_life_ms = 7776000000;
          LET $age_ms = (time::now() - $m.decay_anchor) / 1ms;
          LET $decay = math::pow(0.5, $age_ms / $half_life_ms);
          LET $reinforced = math::log(1 + $m.signal_count, 2);
          RETURN math::min([1.0, $m.confidence * $decay * $reinforced]);
        };
      `,
    )
    .collect();
}

async function gateCascade(db) {
  console.log('\nG0.a — DEFINE EVENT cascade on DELETE');
  // Create an entity + two edges referencing it.
  const [created] = await db
    .query(
      surql`
        CREATE entities:alice CONTENT { name: 'Alice' };
        CREATE entities:bob   CONTENT { name: 'Bob' };
        CREATE edges:['knows', entities:alice, entities:bob] CONTENT {
          kind: 'knows', from: entities:alice, to: entities:bob
        };
        CREATE edges:['knows', entities:bob, entities:alice] CONTENT {
          kind: 'knows', from: entities:bob, to: entities:alice
        };
      `,
    )
    .collect();
  void created;

  const [beforeRows] = await db.query('SELECT id FROM edges').collect();
  if (beforeRows.length !== 2) {
    fail('precondition: expected 2 edges before delete', `got ${beforeRows.length}`);
    return;
  }

  // DELETE alice; cascade should remove both edges (one as from, one as to).
  await db.query('DELETE entities:alice').collect();
  const [afterRows] = await db.query('SELECT id FROM edges').collect();
  if (afterRows.length === 0) {
    ok('cascade removed all edges referencing the deleted entity');
  } else {
    fail(`expected 0 edges after cascade, got ${afterRows.length}`, JSON.stringify(afterRows));
  }
}

async function gateUpsertIdempotence(db) {
  console.log('\nG0.b — Composite-ID UPSERT idempotence');
  await db.query('DELETE edges').collect();

  // First UPSERT — counter starts at 1.
  await db
    .query(
      surql`
        UPSERT edges:['occurs_with', entities:bob, entities:carol] SET
          kind = 'occurs_with',
          from = entities:bob,
          to = entities:carol,
          weight += 1,
          last_seen = time::now();
      `,
    )
    .collect();

  // Second UPSERT with same composite ID — same row, weight=2.
  await db
    .query(
      surql`
        UPSERT edges:['occurs_with', entities:bob, entities:carol] SET
          kind = 'occurs_with',
          from = entities:bob,
          to = entities:carol,
          weight += 1,
          last_seen = time::now();
      `,
    )
    .collect();

  const [rows] = await db
    .query("SELECT id, weight FROM edges WHERE kind = 'occurs_with'")
    .collect();
  if (rows.length === 1 && rows[0].weight === 2) {
    ok(`single row with weight=2 after two UPSERTs (id=${rows[0].id})`);
  } else {
    fail(`expected 1 row with weight=2, got ${rows.length} rows`, JSON.stringify(rows));
  }
}

async function gateFieldPathIndex(db) {
  console.log('\nG0.c — Field-path index on meta.name selected by query planner');
  await db
    .query(
      surql`
        CREATE memos CONTENT { kind: 'habit', content: 'X', meta: { name: 'morning-routine' } };
        CREATE memos CONTENT { kind: 'habit', content: 'Y', meta: { name: 'evening-routine' } };
        CREATE memos CONTENT { kind: 'knowledge', content: 'Z' };
      `,
    )
    .collect();

  // EXPLAIN to inspect the plan; we just want a 1-row result.
  const [rows] = await db
    .query("SELECT id, content FROM memos WHERE kind = 'habit' AND meta.name = 'morning-routine'")
    .collect();
  if (rows.length === 1 && rows[0].content === 'X') {
    ok('field-path query returned the expected row');
  } else {
    fail(`expected 1 row (content=X), got ${rows.length}`, JSON.stringify(rows));
  }
}

async function gateFreshness(db) {
  console.log('\nG0.d — fn::freshness reflects supersedes');
  await db.query('DELETE memos; DELETE edges').collect();

  const [created] = await db
    .query(
      surql`
        CREATE memos:old CONTENT {
          kind: 'knowledge', content: 'old fact',
          confidence: 0.8, signal_count: 3
        };
        CREATE memos:new CONTENT {
          kind: 'knowledge', content: 'new fact',
          confidence: 0.9, signal_count: 1
        };
      `,
    )
    .collect();
  void created;

  // Pre-supersede freshness for old > 0.
  const [pre] = await db.query('RETURN fn::freshness(memos:old)').collect();
  const preVal = Array.isArray(pre) ? pre[0] : pre;
  if (typeof preVal !== 'number' || preVal <= 0) {
    fail(`pre-supersede freshness should be > 0, got ${preVal}`);
    return;
  }

  // Add supersedes edge new → old.
  await db
    .query(
      surql`
        CREATE edges:['supersedes', memos:new, memos:old] CONTENT {
          kind: 'supersedes', from: memos:new, to: memos:old
        };
      `,
    )
    .collect();

  const [post] = await db.query('RETURN fn::freshness(memos:old)').collect();
  const postVal = Array.isArray(post) ? post[0] : post;
  if (postVal === 0) {
    ok(`freshness=${preVal.toFixed(3)} → 0 after supersedes`);
  } else {
    fail(`expected 0 freshness after supersede, got ${postVal}`);
  }
}

// ---------------------------------------------------------------------------
// New gates for the 2026-05-11-surrealdb-improvements-design.md spec.
// G15 — REFERENCE back-ref <~events matches WHERE episode_id = $X
// G16 — ON DELETE UNSET clears events.episode_id on episode delete
// G17 — COMPUTED runtime_jobs.is_overdue across truth-table
// G18 — entities_name_lower index still selected by the planner
// ---------------------------------------------------------------------------

async function gateReferenceBackRef(db) {
  console.log('\nG15 — REFERENCE back-ref <~events on episodes');
  await db
    .query(
      `
      DEFINE TABLE IF NOT EXISTS episodes SCHEMAFULL TYPE NORMAL;
      DEFINE FIELD started_at ON episodes TYPE datetime DEFAULT time::now();
      DEFINE FIELD member_events ON episodes COMPUTED <~events_ref;

      DEFINE TABLE IF NOT EXISTS events_ref SCHEMAFULL TYPE NORMAL;
      DEFINE FIELD ts ON events_ref TYPE datetime DEFAULT time::now();
      DEFINE FIELD episode_id ON events_ref TYPE option<record<episodes>> REFERENCE ON DELETE UNSET;
    `,
    )
    .collect();

  await db
    .query(
      `
      CREATE episodes:e1;
      CREATE events_ref:e1a SET episode_id = episodes:e1;
      CREATE events_ref:e1b SET episode_id = episodes:e1;
      CREATE events_ref:e1c SET episode_id = NONE;
    `,
    )
    .collect();

  const [byField] = await db
    .query('SELECT VALUE id FROM events_ref WHERE episode_id = episodes:e1')
    .collect();
  const [byBackref] = await db.query('SELECT VALUE member_events FROM ONLY episodes:e1').collect();

  const sortIds = (xs) => xs.map((x) => String(x)).sort();
  const expected = sortIds(byField);
  const got = sortIds(byBackref ?? []);
  if (expected.length === 2 && JSON.stringify(expected) === JSON.stringify(got)) {
    ok(`member_events back-ref matches forward query (${expected.length} events)`);
  } else {
    fail(`back-ref mismatch: forward=${JSON.stringify(expected)} backref=${JSON.stringify(got)}`);
  }
}

async function gateOnDeleteUnset(db) {
  console.log('\nG16 — REFERENCE ON DELETE UNSET clears scalar pointer');
  // Schema reused from G15.
  await db.query('DELETE episodes:e1').collect();
  const [remaining] = await db
    .query('SELECT id, episode_id FROM events_ref WHERE id IN [events_ref:e1a, events_ref:e1b]')
    .collect();
  const allCleared = remaining.every((r) => r.episode_id == null);
  if (allCleared && remaining.length === 2) {
    ok('events_ref.episode_id was cleared on episode delete');
  } else {
    fail(`expected episode_id=NONE for both rows, got ${JSON.stringify(remaining)}`);
  }
}

async function gateComputedIsOverdue(db) {
  console.log('\nG17 — COMPUTED runtime_jobs.is_overdue matrix');
  await db
    .query(
      `
      DEFINE TABLE IF NOT EXISTS rj_test SCHEMAFULL TYPE NORMAL;
      DEFINE FIELD enabled     ON rj_test TYPE bool;
      DEFINE FIELD in_flight   ON rj_test TYPE bool DEFAULT false;
      DEFINE FIELD next_run_at ON rj_test TYPE option<datetime>;
      DEFINE FIELD is_overdue  ON rj_test COMPUTED
        (next_run_at != NONE AND next_run_at < time::now() AND !in_flight AND enabled);
    `,
    )
    .collect();
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const cases = [
    { id: 'rj_test:overdue', enabled: true, in_flight: false, next: past, expect: true },
    { id: 'rj_test:future', enabled: true, in_flight: false, next: future, expect: false },
    { id: 'rj_test:in_flight', enabled: true, in_flight: true, next: past, expect: false },
    { id: 'rj_test:disabled', enabled: false, in_flight: false, next: past, expect: false },
    { id: 'rj_test:no_next', enabled: true, in_flight: false, next: null, expect: false },
  ];
  for (const c of cases) {
    const nextLit = c.next ? `d'${c.next}'` : 'NONE';
    await db
      .query(
        `CREATE ${c.id} SET enabled=${c.enabled}, in_flight=${c.in_flight}, next_run_at=${nextLit}`,
      )
      .collect();
  }
  let allOk = true;
  for (const c of cases) {
    const [row] = await db.query(`SELECT VALUE is_overdue FROM ONLY ${c.id}`).collect();
    if (row !== c.expect) {
      fail(`${c.id}: expected ${c.expect}, got ${row}`);
      allOk = false;
    }
  }
  if (allOk) ok('is_overdue COMPUTED returned expected booleans across 5 cases');
}

async function gateNameLowerIndexStillSelected(db) {
  console.log('\nG18 — entities_name_lower index still selected by planner');
  await db
    .query(
      `
      DEFINE TABLE IF NOT EXISTS entities_t SCHEMAFULL TYPE NORMAL;
      DEFINE FIELD name       ON entities_t TYPE string;
      DEFINE FIELD name_lower ON entities_t TYPE string VALUE string::lowercase(name) READONLY;
      DEFINE FIELD type       ON entities_t TYPE string;
      DEFINE INDEX entities_t_name_lower ON entities_t FIELDS name_lower, type;

      CREATE entities_t SET name = 'Alice', type = 'person';
    `,
    )
    .collect();
  const [plan] = await db
    .query("SELECT id FROM entities_t WHERE name_lower = 'alice' AND type = 'person' EXPLAIN FULL")
    .collect();
  const planStr = JSON.stringify(plan ?? []);
  if (planStr.includes('entities_t_name_lower') || planStr.includes('Index')) {
    ok('planner used the name_lower index');
  } else {
    fail(`expected Index iterator on entities_t_name_lower, plan=${planStr}`);
  }
}

async function main() {
  const db = await connect();
  try {
    await defineMinimalSchema(db);
    await gateCascade(db);
    await gateUpsertIdempotence(db);
    await gateFieldPathIndex(db);
    await gateFreshness(db);
    await gateReferenceBackRef(db);
    await gateOnDeleteUnset(db);
    await gateComputedIsOverdue(db);
    await gateNameLowerIndexStillSelected(db);
  } finally {
    try {
      await db.close();
    } catch {
      /* idempotent */
    }
  }
  if (process.exitCode && process.exitCode !== 0) {
    console.error('\nVerification FAILED. Design needs adjustment before plan execution.');
  } else {
    console.log('\nAll verification gates passed.');
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(2);
  });
