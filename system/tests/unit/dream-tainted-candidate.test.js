// system/tests/unit/dream-tainted-candidate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, close } from '../../data/db/client.js';
import { createUpdateRuleTool } from '../../io/mcp/tools/update-rule.js';

async function setup() {
  const db = await connect({ engine: 'mem://' });
  await db.query(`
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
