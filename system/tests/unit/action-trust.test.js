// tests/unit/action-trust.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  checkActionTrust,
  demoteOnCorrection,
  getActionTrust,
  listActionTrust,
  recordOutcome,
  resetActionTrust,
  setActionTrust,
} from '../../cognition/jobs/action-trust.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('checkActionTrust — auto-creates with default ASK on first sight', async () => {
  const db = await fresh();
  const r = await checkActionTrust(db, 'discord_send', 'send_dm');
  assert.equal(r.class, 'discord_send:send_dm');
  assert.equal(r.state, 'ASK');
  assert.equal(r.set_by, 'default');
  assert.ok(r.last_state_change_at instanceof Date);
  await close(db);
});

test('checkActionTrust — idempotent on repeat call', async () => {
  const db = await fresh();
  const a = await checkActionTrust(db, 'discord_send', 'send_dm');
  const b = await checkActionTrust(db, 'discord_send', 'send_dm');
  assert.equal(a.class, b.class);
  // Same row, same last_state_change_at
  assert.equal(+a.last_state_change_at, +b.last_state_change_at);
  await close(db);
});

test('setActionTrust — flips state + updates set_by + last_state_change_at', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'spotify_write', 'queue');
  await new Promise((r) => setTimeout(r, 5));
  await setActionTrust(db, 'spotify_write:queue', 'AUTO', 'user');
  const r = await getActionTrust(db, 'spotify_write:queue');
  assert.equal(r.state, 'AUTO');
  assert.equal(r.set_by, 'user');
  await close(db);
});

test('recordOutcome — success increments success_count + last_used_at', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'github_write', 'create-issue');
  await recordOutcome(db, 'github_write:create-issue', 'success');
  await recordOutcome(db, 'github_write:create-issue', 'success');
  const r = await getActionTrust(db, 'github_write:create-issue');
  assert.equal(r.success_count, 2);
  assert.ok(r.last_used_at instanceof Date);
  await close(db);
});

test('recordOutcome — correction on AUTO row auto-demotes to ASK with set_by=correction', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'discord_send', 'send_channel');
  await setActionTrust(db, 'discord_send:send_channel', 'AUTO', 'user');
  await recordOutcome(db, 'discord_send:send_channel', 'correction');
  const r = await getActionTrust(db, 'discord_send:send_channel');
  assert.equal(r.state, 'ASK');
  assert.equal(r.set_by, 'correction');
  assert.equal(r.correction_count, 1);
  await close(db);
});

test('recordOutcome — correction on ASK row only increments count, no flip', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'discord_send', 'send_dm');
  await recordOutcome(db, 'discord_send:send_dm', 'correction');
  const r = await getActionTrust(db, 'discord_send:send_dm');
  assert.equal(r.state, 'ASK');
  assert.equal(r.set_by, 'default');
  assert.equal(r.correction_count, 1);
  await close(db);
});

test('demoteOnCorrection — returns {demoted: true, from: AUTO} on flip', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'spotify_write', 'queue');
  await setActionTrust(db, 'spotify_write:queue', 'AUTO', 'user');
  const r = await demoteOnCorrection(db, 'spotify_write:queue');
  assert.equal(r.demoted, true);
  assert.equal(r.from, 'AUTO');
  await close(db);
});

test('demoteOnCorrection — returns {demoted: false} when already ASK', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'spotify_write', 'skip');
  const r = await demoteOnCorrection(db, 'spotify_write:skip');
  assert.equal(r.demoted, false);
  await close(db);
});

test('resetActionTrust — flips back to ASK + default, preserves counts', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'github_write', 'comment');
  await setActionTrust(db, 'github_write:comment', 'AUTO', 'user');
  await recordOutcome(db, 'github_write:comment', 'success');
  await resetActionTrust(db, 'github_write:comment');
  const r = await getActionTrust(db, 'github_write:comment');
  assert.equal(r.state, 'ASK');
  assert.equal(r.set_by, 'default');
  assert.equal(r.success_count, 1, 'counts preserved');
  await close(db);
});

test('listActionTrust — returns all rows ordered by class', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'spotify_write', 'queue');
  await checkActionTrust(db, 'discord_send', 'send_dm');
  await checkActionTrust(db, 'github_write', 'comment');
  const rows = await listActionTrust(db);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].class, 'discord_send:send_dm');
  assert.equal(rows[1].class, 'github_write:comment');
  assert.equal(rows[2].class, 'spotify_write:queue');
  await close(db);
});
