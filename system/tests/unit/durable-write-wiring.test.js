import assert from 'node:assert/strict';
import test from 'node:test';
import { __setEnvForTests } from '../../cognition/discretion/durable-write.js';
import { close, connect } from '../../data/db/client.js';
import { createRememberTool } from '../../io/mcp/tools/remember.js';
import { __resetForTests, markTainted } from '../../runtime/mcp/session-taint.js';

test('remember returns outbound_blocked envelope on session-taint refusal', async () => {
  __resetForTests();
  __setEnvForTests('enforce');
  markTainted('s1', 'events:e_evil');
  const db = await connect({ engine: 'mem://' });
  try {
    await db
      .query(`
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
    `)
      .collect();
    const tool = createRememberTool({
      db,
      embedder: { embed: async () => new Float32Array([0.1]) },
      queue: { enqueue: async () => {} },
      getSessionId: () => 's1',
    });
    const out = await tool.handler({ content: 'something', trigger_biographer: false });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'outbound_blocked');
    assert.equal(out.blocked_by, 'session_tainted');
  } finally {
    __setEnvForTests(null);
    __resetForTests();
    await close(db);
  }
});
