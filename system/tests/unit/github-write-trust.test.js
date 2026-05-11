// tests/unit/github-write-trust.test.js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as __robinTmpdir, tmpdir } from 'node:os';
import { join as __robinJoin, join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { getActionTrust, setActionTrust } from '../../cognition/jobs/action-trust.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { createGitHubWriteTool } from '../../io/integrations/github_write/tools/github-write.js';

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

async function freshSetup() {
  const { saveSecret } = await import(`../../src/secrets/dotenv-io.js?cb=${Date.now()}`);
  saveSecret('GITHUB_PAT', 'ghp_test');
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'github_write',
    embed: true,
    mode: 'insert-or-skip',
  });
  return { db, capture };
}

// Stub fetch that returns a successful GitHub API response for create-issue
function stubFetchIssue() {
  return mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 201,
    json: async () => ({ number: 1, html_url: 'https://github.com/x/y/issues/1' }),
    text: async () => '',
  }));
}

// Stub fetch for comment
function stubFetchComment() {
  return mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 201,
    json: async () => ({ id: 42, html_url: 'https://github.com/x/y/issues/1#issuecomment-42' }),
    text: async () => '',
  }));
}

// Stub fetch for label
function stubFetchLabel() {
  return mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => [],
    text: async () => '',
  }));
}

// Stub fetch for mark-read
function stubFetchMarkRead() {
  return mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 205,
    json: async () => null,
    text: async () => '',
  }));
}

// --- ASK default (first-call) behaviour for all 4 actions ---

test('create-issue: first call defaults to ASK — refuses without force', async () => {
  const { db, capture } = await freshSetup();
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({
    action: 'create-issue',
    args: { repo: 'x/y', title: 'T', body: 'B' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_permission');
  assert.equal(r.class, 'github_write:create-issue');
  assert.ok(r.last_state_change_at instanceof Date);
  await close(db);
});

test('comment: first call defaults to ASK — refuses without force', async () => {
  const { db, capture } = await freshSetup();
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({ action: 'comment', args: { repo: 'x/y', issue_id: 1, body: 'hi' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_permission');
  assert.equal(r.class, 'github_write:comment');
  assert.ok(r.last_state_change_at instanceof Date);
  await close(db);
});

test('label: first call defaults to ASK — refuses without force', async () => {
  const { db, capture } = await freshSetup();
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({ action: 'label', args: { repo: 'x/y', issue_id: 1, add: ['bug'] } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_permission');
  assert.equal(r.class, 'github_write:label');
  await close(db);
});

test('mark-read: first call defaults to ASK — refuses without force', async () => {
  const { db, capture } = await freshSetup();
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({ action: 'mark-read', args: { notification_id: 'n1' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_permission');
  assert.equal(r.class, 'github_write:mark-read');
  await close(db);
});

// --- ASK + force:true proceeds ---

test('create-issue: ASK + force:true proceeds', async () => {
  const { db, capture } = await freshSetup();
  const fakeFetch = stubFetchIssue();
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'create-issue',
      args: { repo: 'x/y', title: 'T', body: 'B', force: true },
    });
    assert.equal(r.ok, true);
    assert.equal(r.id, 1);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('comment: ASK + force:true proceeds', async () => {
  const { db, capture } = await freshSetup();
  const fakeFetch = stubFetchComment();
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'comment',
      args: { repo: 'x/y', issue_id: 1, body: 'hi', force: true },
    });
    assert.equal(r.ok, true);
    assert.equal(r.id, 42);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('label: ASK + force:true proceeds', async () => {
  const { db, capture } = await freshSetup();
  const fakeFetch = stubFetchLabel();
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'label',
      args: { repo: 'x/y', issue_id: 1, add: ['bug'], force: true },
    });
    assert.equal(r.ok, true);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('mark-read: ASK + force:true proceeds', async () => {
  const { db, capture } = await freshSetup();
  const fakeFetch = stubFetchMarkRead();
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'mark-read',
      args: { notification_id: 'n1', force: true },
    });
    assert.equal(r.ok, true);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

// --- AUTO proceeds without force ---

test('create-issue: AUTO proceeds without force', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:create-issue', 'AUTO', 'user');
  const fakeFetch = stubFetchIssue();
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'create-issue',
      args: { repo: 'x/y', title: 'T', body: 'B' },
    });
    assert.equal(r.ok, true);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('comment: AUTO proceeds without force', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:comment', 'AUTO', 'user');
  const fakeFetch = stubFetchComment();
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'comment',
      args: { repo: 'x/y', issue_id: 1, body: 'hi' },
    });
    assert.equal(r.ok, true);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('label: AUTO proceeds without force', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:label', 'AUTO', 'user');
  const fakeFetch = stubFetchLabel();
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'label',
      args: { repo: 'x/y', issue_id: 1, add: ['bug'] },
    });
    assert.equal(r.ok, true);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('mark-read: AUTO proceeds without force', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:mark-read', 'AUTO', 'user');
  const fakeFetch = stubFetchMarkRead();
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'mark-read',
      args: { notification_id: 'n1' },
    });
    assert.equal(r.ok, true);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

// --- NEVER refuses even with force ---

test('create-issue: NEVER refuses even with force:true', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:create-issue', 'NEVER', 'user');
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({
    action: 'create-issue',
    args: { repo: 'x/y', title: 'T', body: 'B', force: true },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'action_not_allowed');
  assert.equal(r.class, 'github_write:create-issue');
  await close(db);
});

test('comment: NEVER refuses even with force:true', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:comment', 'NEVER', 'user');
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({
    action: 'comment',
    args: { repo: 'x/y', issue_id: 1, body: 'hi', force: true },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'action_not_allowed');
  await close(db);
});

test('label: NEVER refuses even with force:true', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:label', 'NEVER', 'user');
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({
    action: 'label',
    args: { repo: 'x/y', issue_id: 1, add: ['bug'], force: true },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'action_not_allowed');
  await close(db);
});

test('mark-read: NEVER refuses even with force:true', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:mark-read', 'NEVER', 'user');
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({
    action: 'mark-read',
    args: { notification_id: 'n1', force: true },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'action_not_allowed');
  await close(db);
});

// --- success_count increments for the right class ---

test('successful create-issue increments success_count for github_write:create-issue', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:create-issue', 'AUTO', 'user');
  const fakeFetch = stubFetchIssue();
  try {
    const t = createGitHubWriteTool({ db, capture });
    await t.handler({ action: 'create-issue', args: { repo: 'x/y', title: 'T', body: 'B' } });
    await t.handler({ action: 'create-issue', args: { repo: 'x/y', title: 'T2', body: 'B2' } });
    const row = await getActionTrust(db, 'github_write:create-issue');
    assert.equal(row.success_count, 2);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

test('successful comment increments success_count for github_write:comment', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:comment', 'AUTO', 'user');
  const fakeFetch = stubFetchComment();
  try {
    const t = createGitHubWriteTool({ db, capture });
    await t.handler({ action: 'comment', args: { repo: 'x/y', issue_id: 1, body: 'hi' } });
    const row = await getActionTrust(db, 'github_write:comment');
    assert.equal(row.success_count, 1);
  } finally {
    fakeFetch.mock.restore();
    await close(db);
  }
});

// --- class isolation: github_write:comment AUTO does NOT affect github_write:create-issue ---

test('setting github_write:comment to AUTO does not affect github_write:create-issue', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'github_write:comment', 'AUTO', 'user');
  const t = createGitHubWriteTool({ db, capture });
  // create-issue is still at default ASK
  const r = await t.handler({
    action: 'create-issue',
    args: { repo: 'x/y', title: 'T', body: 'B' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_permission');
  assert.equal(r.class, 'github_write:create-issue');
  await close(db);
});
