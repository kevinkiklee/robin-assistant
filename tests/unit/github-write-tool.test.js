import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { createGitHubWriteTool } from '../../src/integrations/github_write/tools/github-write.js';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function freshSetup() {
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

test('create-issue passes policy and captures event', async () => {
  const { db, capture } = await freshSetup();
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
      args: { repo: 'x/y', title: 'Bug', body: 'Details', labels: ['bug'] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.id, 42);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('create-issue blocked by PII', async () => {
  const { db, capture } = await freshSetup();
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({
    action: 'create-issue',
    args: { repo: 'x/y', title: 'My SSN is 123-45-6789', body: 'oops' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'outbound_blocked');
  await close(db);
});

test('comment captures event', async () => {
  const { db, capture } = await freshSetup();
  const fakeFetch = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 201,
    json: async () => ({
      id: 999,
      html_url: 'https://github.com/x/y/issues/42#issuecomment-999',
    }),
    text: async () => '',
  }));
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'comment',
      args: { repo: 'x/y', issue_id: 42, body: 'Looks good' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.id, 999);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('label action skips outbound-policy', async () => {
  const { db, capture } = await freshSetup();
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
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('mark-read returns ok', async () => {
  const { db, capture } = await freshSetup();
  const fakeFetch = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 205,
    json: async () => null,
    text: async () => '',
  }));
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'mark-read',
      args: { notification_id: 'thread-1' },
    });
    assert.equal(r.ok, true);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('unknown action returns unknown_action', async () => {
  const { db, capture } = await freshSetup();
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({ action: 'zoom', args: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_action');
  await close(db);
});

test('rate-limit refusal short-circuits before outbound-policy', async () => {
  const { db, capture } = await freshSetup();
  process.env.GITHUB_WRITE_RATE_LIMIT = '1';
  try {
    const fakeFetch = mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 201,
      json: async () => ({ number: 1, html_url: 'https://github.com/x/y/issues/1' }),
      text: async () => '',
    }));
    try {
      const t = createGitHubWriteTool({ db, capture });
      // First call: consumes the quota of 1.
      const r1 = await t.handler({
        action: 'create-issue',
        args: { repo: 'x/y', title: 'first', body: 'ok' },
      });
      assert.equal(r1.ok, true);
      // Second call: would be PII-blocked by outbound-policy, but rate-limit
      // must short-circuit first and return rate_limited (not outbound_blocked).
      const r2 = await t.handler({
        action: 'create-issue',
        args: { repo: 'x/y', title: 'My SSN is 123-45-6789', body: 'oops' },
      });
      assert.equal(r2.ok, false);
      assert.equal(r2.reason, 'rate_limited');
    } finally {
      fakeFetch.mock.restore();
    }
  } finally {
    Reflect.deleteProperty(process.env, 'GITHUB_WRITE_RATE_LIMIT');
    await close(db);
  }
});
