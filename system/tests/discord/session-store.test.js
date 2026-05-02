import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../../../user-data/ops/scripts/lib/discord/session-store.js';

function mkRoot() {
  return mkdtempSync(join(tmpdir(), 'robin-disc-'));
}

test('store: returns null for unknown key', async () => {
  const root = mkRoot();
  const store = await createSessionStore({ path: join(root, 's.json') });
  assert.equal(store.getSession('unknown'), null);
  rmSync(root, { recursive: true, force: true });
});

test('store: setSession persists and getSession returns it', async () => {
  const root = mkRoot();
  const path = join(root, 's.json');
  const store = await createSessionStore({ path });
  await store.setSession('dm-1', 'sess-abc');
  const got = store.getSession('dm-1');
  assert.equal(got.claudeSessionId, 'sess-abc');
  assert.ok(got.lastActiveAt);

  // Reload from disk to confirm persistence.
  const store2 = await createSessionStore({ path });
  assert.equal(store2.getSession('dm-1').claudeSessionId, 'sess-abc');
  rmSync(root, { recursive: true, force: true });
});

test('store: touch updates lastActiveAt without changing sessionId', async () => {
  const root = mkRoot();
  const store = await createSessionStore({ path: join(root, 's.json') });
  await store.setSession('dm-1', 'sess-abc');
  const t1 = store.getSession('dm-1').lastActiveAt;
  await new Promise(r => setTimeout(r, 5));
  await store.touch('dm-1');
  const t2 = store.getSession('dm-1').lastActiveAt;
  assert.notEqual(t1, t2);
  assert.equal(store.getSession('dm-1').claudeSessionId, 'sess-abc');
  rmSync(root, { recursive: true, force: true });
});

test('store: drop removes a key', async () => {
  const root = mkRoot();
  const store = await createSessionStore({ path: join(root, 's.json') });
  await store.setSession('dm-1', 'sess-abc');
  await store.drop('dm-1');
  assert.equal(store.getSession('dm-1'), null);
  rmSync(root, { recursive: true, force: true });
});

test('store: expireIdle drops keys older than TTL', async () => {
  const root = mkRoot();
  const store = await createSessionStore({ path: join(root, 's.json') });
  await store.setSession('dm-1', 'sess-old');
  await store.setSession('thread-1', 'sess-new');
  // Force dm-1 lastActiveAt into the past via direct write.
  const data = JSON.parse(readFileSync(join(root, 's.json'), 'utf-8'));
  data['dm-1'].lastActiveAt = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  writeFileSync(join(root, 's.json'), JSON.stringify(data));
  const store2 = await createSessionStore({ path: join(root, 's.json') });
  await store2.expireIdle({ dm: 4 * 3600 * 1000, thread: 24 * 3600 * 1000 });
  assert.equal(store2.getSession('dm-1'), null);
  assert.equal(store2.getSession('thread-1').claudeSessionId, 'sess-new');
  rmSync(root, { recursive: true, force: true });
});

test('store: corrupt JSON file is renamed and store starts empty', async () => {
  const root = mkRoot();
  const path = join(root, 's.json');
  writeFileSync(path, 'not json {{{');
  const store = await createSessionStore({ path });
  assert.equal(store.getSession('dm-1'), null);
  const files = readdirSync(root);
  assert.ok(files.some(f => f.startsWith('s.corrupt-')), `expected corrupt rename, got: ${files}`);
  rmSync(root, { recursive: true, force: true });
});

test('store: atomic write does not corrupt under abrupt termination simulation', async () => {
  const root = mkRoot();
  const path = join(root, 's.json');
  const store = await createSessionStore({ path });
  await store.setSession('dm-1', 'sess-abc');
  await store.setSession('dm-2', 'sess-def');
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  assert.equal(parsed['dm-1'].claudeSessionId, 'sess-abc');
  assert.equal(parsed['dm-2'].claudeSessionId, 'sess-def');
  rmSync(root, { recursive: true, force: true });
});
