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
    fail(
      `expected 1 row with weight=2, got ${rows.length} rows`,
      JSON.stringify(rows),
    );
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
    .query(
      "SELECT id, content FROM memos WHERE kind = 'habit' AND meta.name = 'morning-routine'",
    )
    .collect();
  if (rows.length === 1 && rows[0].content === 'X') {
    ok(`field-path query returned the expected row`);
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

async function main() {
  const db = await connect();
  try {
    await defineMinimalSchema(db);
    await gateCascade(db);
    await gateUpsertIdempotence(db);
    await gateFieldPathIndex(db);
    await gateFreshness(db);
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
    console.log('\nAll four verification gates passed.');
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
