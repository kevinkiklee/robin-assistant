// system/tests/unit/dream-tainted-candidate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, close } from '../../data/db/client.js';
import { createUpdateRuleTool } from '../../io/mcp/tools/update-rule.js';
import { __resetCacheForTests } from '../../cognition/discretion/verbatim-scan.js';
import { dreamStepReflection } from '../../cognition/dream/step-reflection.js';

async function setup() {
  __resetCacheForTests();
  const db = await connect({ engine: 'mem://' });
  await db.query(`
    DEFINE TABLE events SCHEMAFULL;
    DEFINE FIELD content ON events TYPE string;
    DEFINE FIELD trust   ON events TYPE string DEFAULT 'trusted';
    DEFINE FIELD ts      ON events TYPE datetime DEFAULT time::now();
    DEFINE TABLE refusals SCHEMAFULL TYPE NORMAL;
    DEFINE FIELD direction   ON refusals TYPE string DEFAULT 'outbound';
    DEFINE FIELD content     ON refusals TYPE string;
    DEFINE FIELD reason      ON refusals TYPE string;
    DEFINE FIELD tool        ON refusals TYPE option<string>;
    DEFINE FIELD created_at  ON refusals TYPE datetime DEFAULT time::now() READONLY;
    DEFINE FIELD meta        ON refusals TYPE option<object> FLEXIBLE;
    DEFINE TABLE rule_candidates SCHEMAFULL;
    DEFINE FIELD content             ON rule_candidates TYPE string;
    DEFINE FIELD kind                ON rule_candidates TYPE string;
    DEFINE FIELD status              ON rule_candidates TYPE string DEFAULT 'pending';
    DEFINE FIELD signal_events       ON rule_candidates TYPE array DEFAULT [];
    DEFINE FIELD confidence          ON rule_candidates TYPE float DEFAULT 0.7;
    DEFINE FIELD derived_from_trust  ON rule_candidates TYPE string DEFAULT 'trusted';
    DEFINE FIELD reviewed_at         ON rule_candidates TYPE option<datetime>;
    DEFINE FIELD rejected_reason     ON rule_candidates TYPE option<string>;
    DEFINE TABLE rules SCHEMAFULL;
    DEFINE FIELD content             ON rules TYPE string;
    DEFINE FIELD kind                ON rules TYPE string;
    DEFINE FIELD source_candidate    ON rules TYPE option<record<rule_candidates>>;
    DEFINE FIELD active              ON rules TYPE bool DEFAULT true;
    DEFINE FIELD priority            ON rules TYPE option<int>;
    DEFINE FIELD payload             ON rules TYPE option<object> FLEXIBLE;
    DEFINE FIELD derived_from_trust  ON rules TYPE string DEFAULT 'trusted';
    CREATE rule_candidates:tainted SET content='evil rule', kind='behavior', derived_from_trust='untrusted';
    CREATE rule_candidates:clean   SET content='good rule', kind='behavior', derived_from_trust='trusted';
  `).collect();
  return db;
}

test('update_rule(approve) on tainted candidate refused without force', async () => {
  const db = await setup();
  try {
    const tool = createUpdateRuleTool({ db });
    const out = await tool.handler({ id: 'rule_candidates:tainted', action: 'approve' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'tainted_candidate');
  } finally {
    await close(db);
  }
});

test('update_rule(approve) on tainted candidate succeeds with force=true', async () => {
  const db = await setup();
  try {
    const tool = createUpdateRuleTool({ db });
    const out = await tool.handler({ id: 'rule_candidates:tainted', action: 'approve', force: true });
    assert.equal(out.ok, true);
  } finally {
    await close(db);
  }
});

test('update_rule(approve) on clean candidate succeeds without force', async () => {
  const db = await setup();
  try {
    const tool = createUpdateRuleTool({ db });
    const out = await tool.handler({ id: 'rule_candidates:clean', action: 'approve' });
    assert.equal(out.ok, true);
  } finally {
    await close(db);
  }
});

// Regression: step-reflection was reading `derived_from_trust` from events,
// but events only carry `trust`. mergeTrust([undefined,...]) fell back to
// 'trusted', silently mis-tagging untrusted-sourced rule_candidates as trusted.
test('dreamStepReflection: untrusted event produces untrusted rule_candidate', async () => {
  __resetCacheForTests();
  const db = await connect({ engine: 'mem://' });
  try {
    await db.query(`
      DEFINE TABLE events SCHEMAFULL;
      DEFINE FIELD content          ON events TYPE string;
      DEFINE FIELD trust            ON events TYPE string DEFAULT 'trusted';
      DEFINE FIELD ts               ON events TYPE datetime DEFAULT time::now();
      DEFINE FIELD meta             ON events TYPE option<object> FLEXIBLE;
      DEFINE FIELD biographed_at    ON events TYPE option<datetime>;
      DEFINE TABLE rule_candidates SCHEMAFULL;
      DEFINE FIELD content              ON rule_candidates TYPE string;
      DEFINE FIELD kind                 ON rule_candidates TYPE string;
      DEFINE FIELD status               ON rule_candidates TYPE string DEFAULT 'pending';
      DEFINE FIELD signal_events        ON rule_candidates TYPE array DEFAULT [];
      DEFINE FIELD confidence           ON rule_candidates TYPE float DEFAULT 0.7;
      DEFINE FIELD derived_from_trust   ON rule_candidates TYPE string DEFAULT 'trusted';
      DEFINE FIELD payload              ON rule_candidates TYPE option<object> FLEXIBLE;
      DEFINE FIELD meta                 ON rule_candidates TYPE option<object> FLEXIBLE;
      DEFINE FIELD reviewed_at          ON rule_candidates TYPE option<datetime>;
      DEFINE FIELD rejected_reason      ON rule_candidates TYPE option<string>;
      DEFINE TABLE runtime SCHEMAFULL;
      DEFINE FIELD value                ON runtime TYPE option<object> FLEXIBLE;
      DEFINE TABLE embeddings_test_events SCHEMAFULL;
      DEFINE FIELD record ON embeddings_test_events TYPE record<events>;
      DEFINE FIELD vector ON embeddings_test_events TYPE array<float>;
    `).collect();

    await db
      .query("UPSERT runtime:embedder SET value = { active_profile: 'test', read_profile: 'test' }")
      .collect();

    // Three untrusted correction events (minCluster=3) with identical embeddings
    // so they form one cluster and trigger the LLM call + candidate write.
    const vec = Array.from({ length: 4 }, () => 0.5);
    const now = new Date();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const [created] = await db
        .query(
          "CREATE events SET content = $c, trust = 'untrusted', ts = $ts, meta = { kind: 'correction', task_type: 'test' }",
          { c: `untrusted correction ${i}`, ts: now },
        )
        .collect();
      const row = Array.isArray(created) ? created[0] : created;
      ids.push(row.id);
      await db
        .query('CREATE embeddings_test_events SET record = $id, vector = $v', { id: row.id, v: vec })
        .collect();
    }

    // Mock LLM: always proposes a rule.
    const host = {
      invokeLLM: async () => ({
        content: JSON.stringify({ propose: true, rule_text: 'test rule', confidence: 0.9 }),
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    };

    const result = await dreamStepReflection(db, host, { minCluster: 3 });
    assert.equal(result.proposed, 1, 'expected one candidate proposed');

    const [candidates] = await db
      .query("SELECT derived_from_trust FROM rule_candidates WHERE status = 'pending'")
      .collect();
    assert.equal(candidates.length, 1, 'expected one pending candidate');
    assert.equal(
      candidates[0].derived_from_trust,
      'untrusted',
      'candidate derived from untrusted events must be tagged untrusted (not trusted)',
    );
  } finally {
    await close(db);
  }
});
