// system/tests/unit/injection-corpus.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect, close } from '../../data/db/client.js';
import { wrapUntrusted } from '../../cognition/discretion/wrap-untrusted.js';
import { checkDurableWrite, __setEnvForTests } from '../../cognition/discretion/durable-write.js';
import { markTainted, __resetForTests } from '../../runtime/mcp/session-taint.js';

const corpus = JSON.parse(readFileSync(
  new URL('../fixtures/prompt-injection/corpus.json', import.meta.url), 'utf8'
));

async function setupDb() {
  const db = await connect({ engine: 'mem://' });
  await db.query(`
    DEFINE TABLE events SCHEMAFULL;
    DEFINE FIELD content ON events TYPE string;
    DEFINE FIELD trust   ON events TYPE string DEFAULT 'trusted';
    DEFINE FIELD ts      ON events TYPE datetime DEFAULT time::now();
    DEFINE TABLE refusals SCHEMAFULL;
    DEFINE FIELD content             ON refusals TYPE string;
    DEFINE FIELD reason              ON refusals TYPE string;
    DEFINE FIELD direction           ON refusals TYPE string;
    DEFINE FIELD meta                ON refusals TYPE object;
    DEFINE FIELD meta.destination    ON refusals TYPE string;
    DEFINE FIELD meta.payload_hash   ON refusals TYPE string;
  `).collect();
  return db;
}

for (const entry of corpus) {
  test(`A: wrap survives ${entry.id} (${entry.technique})`, () => {
    const wrapped = wrapUntrusted(entry.body, { source: 'test', eventId: 'events:t', trust: 'untrusted' });
    // Nonce-suffixed close tag exists and is unique
    const closeMatch = wrapped.match(/<\/untrusted-content-([A-Za-z0-9_-]+)>$/);
    assert.ok(closeMatch, `wrapper close present: ${entry.id}`);
    const nonce = closeMatch[1];
    // Body's literal close tag (if any) does NOT collide with nonce-suffixed close
    assert.ok(!entry.body.includes(`</untrusted-content-${nonce}>`), `body cannot precompute nonce: ${entry.id}`);
    // Body preserved verbatim (so the agent can still see + summarize it)
    assert.ok(wrapped.includes(entry.body), `body preserved: ${entry.id}`);
  });
}

test('C: laundering corpus entry refused when quoted into remember from tainted session', async () => {
  __resetForTests();
  __setEnvForTests('enforce');
  markTainted('s1', 'events:e_evil');
  const db = await setupDb();
  try {
    const laundering = corpus.find(c => c.id === 'laundering');
    const out = await checkDurableWrite(db, {
      destination: 'remember',
      text: laundering.body,
      sessionTaint: { tainted: true, sources: new Set(['events:e_evil']) },
      force: false,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'session_tainted');
  } finally {
    __setEnvForTests(null);
    await close(db);
  }
});
