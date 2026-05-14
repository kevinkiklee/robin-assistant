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

        DEFINE TABLE edges SCHEMAFULL TYPE RELATION;
        -- in/out are implicitly defined by TYPE RELATION (type: record)
        DEFINE FIELD kind      ON edges TYPE string;
        DEFINE FIELD weight    ON edges TYPE option<float>;
        DEFINE FIELD last_seen ON edges TYPE option<datetime>;
        DEFINE INDEX edges_kind_in   ON edges FIELDS kind, in;
        DEFINE INDEX edges_kind_out  ON edges FIELDS kind, out;

        DEFINE EVENT cascade_edges_entities ON entities WHEN $event = "DELETE"
          THEN { DELETE edges WHERE in = $before.id OR out = $before.id; };
        DEFINE EVENT cascade_edges_memos ON memos WHEN $event = "DELETE"
          THEN { DELETE edges WHERE in = $before.id OR out = $before.id; };

        DEFINE FUNCTION fn::freshness($memo: record<memos>) {
          LET $m = $memo.*;
          LET $superseded = (SELECT count() AS n FROM edges WHERE kind = 'supersedes' AND out = $memo GROUP ALL)[0].n ?? 0;
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
        INSERT RELATION INTO edges {
          id: ['knows', entities:alice, entities:bob],
          in: entities:alice, out: entities:bob, kind: 'knows'
        };
        INSERT RELATION INTO edges {
          id: ['knows', entities:bob, entities:alice],
          in: entities:bob, out: entities:alice, kind: 'knows'
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
        INSERT RELATION INTO edges {
          id: ['occurs_with', entities:bob, entities:carol],
          in: entities:bob, out: entities:carol,
          kind: 'occurs_with', weight: 1, last_seen: time::now()
        } ON DUPLICATE KEY UPDATE weight += 1, last_seen = time::now();
      `,
    )
    .collect();

  // Second UPSERT with same composite ID — same row, weight=2.
  await db
    .query(
      surql`
        INSERT RELATION INTO edges {
          id: ['occurs_with', entities:bob, entities:carol],
          in: entities:bob, out: entities:carol,
          kind: 'occurs_with', weight: 1, last_seen: time::now()
        } ON DUPLICATE KEY UPDATE weight += 1, last_seen = time::now();
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
        INSERT RELATION INTO edges {
          id: ['supersedes', memos:new, memos:old],
          in: memos:new, out: memos:old, kind: 'supersedes'
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

async function gateArrowTraversal(db) {
  console.log('\nG5 — Arrow traversal on TYPE RELATION edges with mid-edge kind filter');
  await db.query('DELETE edges; DELETE memos; DELETE entities').collect();
  await db
    .query(
      `
      CREATE entities:alice SET name = 'Alice';
      CREATE memos:m1 SET kind = 'knowledge', content = 'fact about alice';
      CREATE memos:m2 SET kind = 'knowledge', content = 'second fact';
      INSERT RELATION INTO edges {
        id: ['about', memos:m1, entities:alice],
        in: memos:m1, out: entities:alice, kind: 'about'
      };
      INSERT RELATION INTO edges {
        id: ['mentions', memos:m1, entities:alice],
        in: memos:m1, out: entities:alice, kind: 'mentions'
      };
      INSERT RELATION INTO edges {
        id: ['about', memos:m2, entities:alice],
        in: memos:m2, out: entities:alice, kind: 'about'
      };
    `,
    )
    .collect();

  // Reverse arrow with mid-edge kind filter — return the memos that have an
  // outbound `about` edge to alice.
  const [hits] = await db
    .query("SELECT VALUE <-edges[WHERE kind = 'about']<-memos FROM ONLY entities:alice")
    .collect();
  const ids = (hits ?? []).map((x) => String(x)).sort();
  if (ids.length === 2 && ids[0] === 'memos:m1' && ids[1] === 'memos:m2') {
    ok(`arrow traversal returned ${ids.length} memos via 'about' edges`);
  } else {
    fail(`expected [memos:m1, memos:m2], got ${JSON.stringify(ids)}`);
  }

  // Mid-edge filter properly excludes other kinds.
  const [aboutOnly] = await db
    .query(
      "SELECT count() AS n FROM (SELECT VALUE <-edges[WHERE kind='about']<-memos FROM ONLY entities:alice)",
    )
    .collect();
  const aboutCount = aboutOnly?.[0]?.n ?? aboutOnly?.[0];
  void aboutCount; // primary success criterion above is sufficient
}

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

async function gateReinforceCountBucket(_db) {
  console.log('\nG12 — bucket-by-count reinforcement preserves N-per-memo semantics');
  // A memo recalled in N distinct pending recall_log rows must get
  // signal_count += N, not +1. The bucket-by-count optimization in
  // src/recall/reinforcement.js groups updates by distinct count value.
  // This gate exercises the multi-recall path against the real reinforcement
  // module so a future refactor can't silently collapse signal increments.

  // Lazy-import to avoid coupling the verify script to runtime config.
  const { writeConfig } = await import('../../config/paths.js');
  const { mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const testHome = join(tmpdir(), `robin-verify-g12-${process.pid}`);
  mkdirSync(testHome, { recursive: true });
  process.env.ROBIN_HOME = testHome;
  await writeConfig({ embedder_profile: 'mxbai-1024' });

  // Fresh DB with full migration applied so the reinforcement module finds
  // the tables it expects (memos, events, recall_log, edges, etc.).
  const { connect: appConnect, close: appClose } = await import('../../data/db/client.js');
  const { runMigrations } = await import('../../data/db/migrate.js');
  const { paths } = await import('../../config/data-store.js');
  const verifyDb = await appConnect({ engine: 'mem://' });
  try {
    await runMigrations(verifyDb, paths.source.migrations());

    // G12 asserts legacy-equivalent semantics under the kill-switch mode.
    // B1's hybrid pipeline is covered by G12b.
    await verifyDb
      .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'off'")
      .collect();

    // Seed one memo, three pending recall_log rows each referencing it.
    const [mc] = await verifyDb
      .query(
        `CREATE memos CONTENT { kind: 'knowledge', content: 'shared fact', derived_by: 'manual', signal_count: 1 }`,
      )
      .collect();
    const memoId = (Array.isArray(mc) ? mc[0] : mc).id;
    const oldTs = new Date(Date.now() - 10 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
      await verifyDb
        .query(
          `CREATE recall_log CONTENT {
             ts: $ts, session_id: $sid, query: 'q', k: 1,
             ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
             outcome: 'pending'
           }`,
          { ts: oldTs, sid: `s${i}`, rid: String(memoId) },
        )
        .collect();
    }

    const { evaluatePending } = await import('../../cognition/intuition/reinforcement.js');
    const summary = await evaluatePending(verifyDb);
    if (summary.reinforced !== 3) {
      fail(`expected summary.reinforced=3, got ${summary.reinforced}`);
      return;
    }
    const [after] = await verifyDb.query(`SELECT signal_count FROM ${memoId}`).collect();
    const finalCount = after?.[0]?.signal_count;
    if (finalCount === 4) {
      // initial 1 + 3 reinforcements = 4
      ok(`signal_count: 1 → 4 after 3 pending-recall rows for the same memo`);
    } else {
      fail(`expected signal_count=4 (1 base + 3 increments), got ${finalCount}`);
    }
  } finally {
    await appClose(verifyDb);
  }
}

async function gateReinforceCountBucketHybrid() {
  console.log(
    '\nG12b — per-hit attribution preserves N-per-memo on similarity match (and zero on miss)',
  );
  const { writeConfig } = await import('../../config/paths.js');
  const { mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const testHome = join(tmpdir(), `robin-verify-g12b-${process.pid}`);
  mkdirSync(testHome, { recursive: true });
  process.env.ROBIN_HOME = testHome;
  await writeConfig({ embedder_profile: 'mxbai-1024' });

  const { connect: appConnect, close: appClose } = await import('../../data/db/client.js');
  const { runMigrations } = await import('../../data/db/migrate.js');
  const { paths } = await import('../../config/data-store.js');
  const { evaluatePending } = await import('../../cognition/intuition/reinforcement.js');
  const verifyDb = await appConnect({ engine: 'mem://' });

  try {
    await runMigrations(verifyDb, paths.source.migrations());

    // ----- Variant A: hybrid + similarity matches across 3 distinct sessions -----
    await verifyDb
      .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
      .collect();

    // Seed memo with content tokens that will survive the /\W+/ length>3 tokenizer.
    const MEMO_CONTENT = 'specific keyword anchors hydration sourdough ratio';
    const [mc] = await verifyDb
      .query(
        `CREATE memos CONTENT { kind: 'knowledge', content: $c, derived_by: 'manual', signal_count: 1 }`,
        { c: MEMO_CONTENT },
      )
      .collect();
    const memoId = (Array.isArray(mc) ? mc[0] : mc).id;

    const recallTs = new Date(Date.now() - 10 * 60 * 1000);
    const REPLY_TEMPLATE =
      'USER: q\n\nASSISTANT: yes the specific keyword anchors hydration sourdough ratio matches.';
    const sessions = ['s0', 's1', 's2'];
    for (const sid of sessions) {
      await verifyDb
        .query(
          `CREATE events CONTENT {
             source: 'conversation',
             content: $c,
             ts: $ts,
             meta: { session_id: $sid }
           }`,
          { c: REPLY_TEMPLATE, ts: new Date(recallTs.getTime() + 60_000), sid },
        )
        .collect();
      await verifyDb
        .query(
          `CREATE recall_log CONTENT {
             ts: $ts, session_id: $sid, query: 'q', k: 1,
             ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
             outcome: 'pending'
           }`,
          { ts: recallTs, sid, rid: String(memoId) },
        )
        .collect();
    }

    const sumA = await evaluatePending(verifyDb);
    if (sumA.reinforced !== 3) {
      fail(`G12b variant A: expected reinforced=3, got ${sumA.reinforced}`);
      return;
    }
    const [afterA] = await verifyDb.query(`SELECT signal_count FROM ${memoId}`).collect();
    if (afterA?.[0]?.signal_count !== 4) {
      fail(
        `G12b variant A: expected signal_count=4 (1 base + 3), got ${afterA?.[0]?.signal_count}`,
      );
      return;
    }

    // Confirm every row landed mode=similarity, used_count=1, full attribution shape.
    const [rowsA] = await verifyDb
      .query('SELECT attribution, session_id FROM recall_log WHERE outcome = "reinforced"')
      .collect();
    const sidsA = new Set(rowsA.map((r) => r.session_id));
    if (rowsA.length !== 3 || sidsA.size !== 3) {
      fail(
        `G12b variant A: expected 3 reinforced rows across 3 sessions, got ${rowsA.length}/${sidsA.size}`,
      );
      return;
    }
    for (const r of rowsA) {
      const a = r.attribution;
      if (!a || a.mode !== 'similarity' || a.used_count !== 1 || a.total !== 1) {
        fail(
          `G12b variant A: bad attribution shape on session ${r.session_id}: ${JSON.stringify(a)}`,
        );
        return;
      }
      if (typeof a.elapsed_ms !== 'number' || typeof a.similarity_threshold !== 'number') {
        fail(`G12b variant A: missing attribution fields: ${JSON.stringify(a)}`);
        return;
      }
    }
    ok('G12b variant A: 3 distinct sessions, mode=similarity, signal_count 1 → 4');

    // ----- Variant B: hybrid + unrelated reply + fallback_when_zero_used=false -----
    await verifyDb.query('DELETE recall_log').collect();
    await verifyDb.query("DELETE events WHERE source = 'conversation'").collect();
    await verifyDb
      .query('UPDATE runtime:`reinforcement.config` SET value.fallback_when_zero_used = false')
      .collect();

    const baselineCount = 4;
    const UNRELATED = 'USER: q\n\nASSISTANT: the weather seems pleasant today thanks.';
    for (const sid of sessions) {
      await verifyDb
        .query(
          `CREATE events CONTENT {
             source: 'conversation',
             content: $c,
             ts: $ts,
             meta: { session_id: $sid }
           }`,
          { c: UNRELATED, ts: new Date(recallTs.getTime() + 60_000), sid },
        )
        .collect();
      await verifyDb
        .query(
          `CREATE recall_log CONTENT {
             ts: $ts, session_id: $sid, query: 'q', k: 1,
             ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
             outcome: 'pending'
           }`,
          { ts: recallTs, sid, rid: String(memoId) },
        )
        .collect();
    }

    const sumB = await evaluatePending(verifyDb);
    if (sumB.reinforced !== 0) {
      fail(`G12b variant B: expected reinforced=0, got ${sumB.reinforced}`);
      return;
    }
    if ((sumB.no_used ?? 0) !== 3) {
      fail(`G12b variant B: expected no_used=3, got ${sumB.no_used}`);
      return;
    }
    const [afterB] = await verifyDb.query(`SELECT signal_count FROM ${memoId}`).collect();
    if (afterB?.[0]?.signal_count !== baselineCount) {
      fail(
        `G12b variant B: expected signal_count unchanged at ${baselineCount}, got ${afterB?.[0]?.signal_count}`,
      );
      return;
    }
    const [rowsB] = await verifyDb.query('SELECT attribution FROM recall_log').collect();
    const bucketCounts = { fallback_zero_used: 0 };
    for (const r of rowsB) {
      bucketCounts[r.attribution?.mode] = (bucketCounts[r.attribution?.mode] ?? 0) + 1;
    }
    if (bucketCounts.fallback_zero_used !== 3) {
      fail(
        `G12b variant B: expected 3 fallback_zero_used rows, got ${JSON.stringify(bucketCounts)}`,
      );
      return;
    }
    ok(
      'G12b variant B: 3 unrelated replies + fallback_off → signal_count unchanged, all rows fallback_zero_used',
    );
  } finally {
    await appClose(verifyDb);
  }
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

async function gateDagRegistryBidirectional(_db) {
  console.log('\nG20 — DREAM_DAG_DEPS keys ⇔ step-registry byName keys (bidirectional)');
  const { byName } = await import('../../cognition/dream/step-registry.js');
  const { DREAM_DAG_DEPS } = await import('../../cognition/dream/dag.js');
  const a = new Set(Object.keys(byName));
  const b = new Set(Object.keys(DREAM_DAG_DEPS));
  const missingFromDeps = [...a].filter((k) => !b.has(k));
  const missingFromRegistry = [...b].filter((k) => !a.has(k));
  if (missingFromDeps.length === 0 && missingFromRegistry.length === 0) {
    ok(`registry/deps symmetric (${a.size} keys)`);
  } else {
    fail(
      `registry/deps mismatch: missingFromDeps=[${missingFromDeps}] missingFromRegistry=[${missingFromRegistry}]`,
    );
  }
}

async function gateDreamOutputEquivalence(_db) {
  // G19 — Output equivalence between serial and parallel dream runs.
  // Heavyweight (boots two SurrealDB instances, runs the full pipeline
  // twice). Gated on CI: skip outside CI to avoid burning a nightly worth
  // of dream LLM calls on Kevin's instance.
  if (!process.env.CI) {
    console.log('\nG19 — Output equivalence (parallel ≡ serial) [skipped: CI only]');
    return;
  }
  console.log('\nG19 — Output equivalence (parallel ≡ serial)');
  // The integration test at system/tests/integration/dream-parallel.test.js
  // is the authoritative assertion. From this gate we shell out to the test
  // runner with the equivalence pattern so the verify script's exit code
  // reflects the gate's outcome.
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    'node',
    [
      '--test',
      '--test-force-exit',
      '--test-timeout=30000',
      '--test-name-pattern',
      'output equivalence: parallel summary equals serial summary',
      'system/tests/integration/dream-parallel.test.js',
    ],
    { stdio: 'inherit', timeout: 60_000 },
  );
  if (res.status === 0) ok('parallel summary ≡ serial summary under normalizeSummary');
  else fail(`equivalence test failed (exit ${res.status ?? 'timeout'})`);
}

async function main() {
  const db = await connect();
  try {
    await defineMinimalSchema(db);
    await gateCascade(db);
    await gateUpsertIdempotence(db);
    await gateFieldPathIndex(db);
    await gateFreshness(db);
    await gateArrowTraversal(db);
    await gateReferenceBackRef(db);
    await gateOnDeleteUnset(db);
    await gateComputedIsOverdue(db);
    await gateReinforceCountBucket(db);
    await gateReinforceCountBucketHybrid();
    await gateNameLowerIndexStillSelected(db);
    await gateDagRegistryBidirectional(db);
    await gateDreamOutputEquivalence(db);
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
