// system/tests/unit/recall-marks-taint.test.js
//
// Verifies that recall-family tools call markTainted for any returned row
// whose trust / derived_from_trust is NOT 'trusted'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, close } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { writeConfig } from '../../config/paths.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';
import { createRecallTool } from '../../io/mcp/tools/recall.js';
import { createFindEntityTool } from '../../io/mcp/tools/find-entity.js';
import { createListEpisodesTool } from '../../io/mcp/tools/list-episodes.js';
import { createRecentRefusalsTool } from '../../io/mcp/tools/recent-refusals.js';
import { getSessionTaint, __resetForTests } from '../../runtime/mcp/session-taint.js';

// Set up a ROBIN_HOME for config writes
const testHome = join(tmpdir(), `robin-taint-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testHome, { recursive: true });
process.env.ROBIN_HOME = testHome;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS = resolve(import.meta.dirname, '../../data/db/migrations');

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS);
  return db;
}

function makeDetector() {
  return { check: () => ({ repeat: false }), observe: () => {} };
}

// ── recall.js ─────────────────────────────────────────────────────────────────

test('recall marks session tainted when untrusted row returned', async () => {
  __resetForTests();
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  try {
    // Insert an untrusted event and its embedding directly
    // (recordEvent doesn't expose the trust field — we bypass it here)
    const { BoundQuery } = await import('surrealdb');
    const { activeProfile, embeddingTable } = await import('../../data/embed/profile-router.js');
    const { sha256 } = await import('../../data/embed/hash.js');
    const content = 'injected payload';
    const [created] = await db.query(
      new BoundQuery(
        'CREATE events SET source=$src, content=$c, trust=$t, content_hash=$h',
        { src: 'sync', c: content, t: 'untrusted', h: sha256(content) },
      ),
    ).collect();
    const eventId = (Array.isArray(created) ? created[0] : created).id;
    const vec = Array.from(await e.embed(content));
    const profile = await activeProfile(db);
    const table = embeddingTable(profile, 'events');
    await db.query(
      new BoundQuery(
        'UPSERT type::record($tb, [$rec]) SET record = $rec, vector = $vec, ts = time::now()',
        { tb: table, rec: eventId, vec },
      ),
    ).collect();

    const tool = createRecallTool({
      db,
      embedder: e,
      detector: makeDetector(),
      getSessionId: () => 's1',
    });
    await tool.handler({ query: 'injected', limit: 10 });
    assert.equal(getSessionTaint('s1').tainted, true, 'session should be tainted');
  } finally {
    await close(db);
  }
});

test('recall does NOT taint session when all rows are trusted', async () => {
  __resetForTests();
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  try {
    await recordEvent(db, e, { source: 'cli', content: 'safe content', trust: 'trusted' });

    const tool = createRecallTool({
      db,
      embedder: e,
      detector: makeDetector(),
      getSessionId: () => 's2',
    });
    await tool.handler({ query: 'safe', limit: 10 });
    assert.equal(getSessionTaint('s2').tainted, false, 'session should stay clean');
  } finally {
    await close(db);
  }
});

// ── find-entity.js ────────────────────────────────────────────────────────────

test('find_entity marks session tainted when untrusted entity returned', async () => {
  __resetForTests();
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  try {
    // Insert an untrusted entity directly
    await db.query(
      `CREATE entities:untrusted_person SET name='EvilBot', type='person', derived_from_trust='untrusted'`,
    ).collect();

    const tool = createFindEntityTool({ db, embedder: e, getSessionId: () => 's3' });
    await tool.handler({ name: 'EvilBot', fuzzy: false });
    assert.equal(getSessionTaint('s3').tainted, true, 'session should be tainted by untrusted entity');
  } finally {
    await close(db);
  }
});

// ── list-episodes.js ──────────────────────────────────────────────────────────

test('list_episodes marks session tainted when untrusted episode returned', async () => {
  __resetForTests();
  const db = await fresh();
  try {
    await db.query(
      `CREATE episodes:ep1 SET source='gmail', summary='evil summary', derived_from_trust='untrusted', started_at=time::now()`,
    ).collect();

    const tool = createListEpisodesTool({ db, getSessionId: () => 's4' });
    await tool.handler({ limit: 10 });
    assert.equal(getSessionTaint('s4').tainted, true, 'session should be tainted by untrusted episode');
  } finally {
    await close(db);
  }
});

// ── recent-refusals.js ────────────────────────────────────────────────────────

test('recent_refusals marks session tainted whenever any refusal row returned', async () => {
  __resetForTests();
  const db = await fresh();
  try {
    await db.query(
      `CREATE refusals:r1 SET direction='inbound', reason='blocked', tool='recall', content='bad content', created_at=time::now()`,
    ).collect();

    const tool = createRecentRefusalsTool({ db, getSessionId: () => 's5' });
    await tool.handler({ limit: 10 });
    assert.equal(getSessionTaint('s5').tainted, true, 'session should be tainted by any refusal');
  } finally {
    await close(db);
  }
});

test('recent_refusals does NOT taint session when no refusals returned', async () => {
  __resetForTests();
  const db = await fresh();
  try {
    const tool = createRecentRefusalsTool({ db, getSessionId: () => 's6' });
    await tool.handler({ limit: 10 });
    assert.equal(getSessionTaint('s6').tainted, false, 'empty result should not taint');
  } finally {
    await close(db);
  }
});
