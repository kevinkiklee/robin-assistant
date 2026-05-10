import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { createGitHubWriteTool } from '../../src/integrations/github_write/tools/github-write.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function setup() {
  const { saveSecret } = await import(`../../src/secrets/dotenv-io.js?cb=${Date.now()}`);
  saveSecret('GITHUB_PAT', 'ghp_test');
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'github_write',
    embed: true,
    mode: 'insert-or-skip',
  });
  return { db, capture };
}

test('create-issue clean text → events row', async () => {
  const { db, capture } = await setup();
  const fakeFetch = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 201,
    json: async () => ({ number: 42, html_url: 'https://github.com/x/y/issues/42' }),
    text: async () => '',
  }));
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'create-issue',
      args: { repo: 'x/y', title: 'Bug', body: 'Repro steps go here', labels: ['bug'] },
    });
    assert.equal(r.ok, true);
    const [rows] = await db
      .query(surql`SELECT external_id FROM events WHERE source = 'github_write'`)
      .collect();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].external_id, 'x/y:42');
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('comment with PII → outbound_refusals row, no events row', async () => {
  const { db, capture } = await setup();
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({
    action: 'comment',
    args: { repo: 'x/y', issue_id: 42, body: 'My SSN is 123-45-6789' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'outbound_blocked');
  const [refusals] = await db
    .query(surql`SELECT count() AS n FROM outbound_refusals GROUP ALL`)
    .collect();
  assert.equal(refusals[0].n, 1);
  const [events] = await db
    .query(surql`SELECT count() AS n FROM events WHERE source = 'github_write' GROUP ALL`)
    .collect();
  assert.equal(events[0]?.n ?? 0, 0);
  await close(db);
});

test('label action → no events row, no policy refusal', async () => {
  const { db, capture } = await setup();
  const fakeFetch = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => [],
    text: async () => '',
  }));
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'label',
      args: { repo: 'x/y', issue_id: 42, add: ['bug'] },
    });
    assert.equal(r.ok, true);
    const [events] = await db
      .query(surql`SELECT count() AS n FROM events WHERE source = 'github_write' GROUP ALL`)
      .collect();
    assert.equal(events[0]?.n ?? 0, 0);
    const [refusals] = await db
      .query(surql`SELECT count() AS n FROM outbound_refusals GROUP ALL`)
      .collect();
    assert.equal(refusals[0]?.n ?? 0, 0);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});
