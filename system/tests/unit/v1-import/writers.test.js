// writers.test.js — exercise every v1-import writer against a fresh mem://
// SurrealDB. Each writer is run twice; the second call must skip.

import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../../config/paths.js';
import { close, connect } from '../../../data/db/client.js';
import { runMigrations } from '../../../data/db/migrate.js';
import { findByPath, hashExists } from '../../../runtime/install/v1-import/ledger.js';
import { upsertEdge } from '../../../runtime/install/v1-import/writers/edge-writer.js';
import { upsertEntity } from '../../../runtime/install/v1-import/writers/entity-writer.js';
import { createEvent } from '../../../runtime/install/v1-import/writers/event-writer.js';
import { createMemo } from '../../../runtime/install/v1-import/writers/memo-writer.js';
import { applyFacet } from '../../../runtime/install/v1-import/writers/persona-writer.js';
import { createRefusal } from '../../../runtime/install/v1-import/writers/refusal-writer.js';
import { createRule } from '../../../runtime/install/v1-import/writers/rule-writer.js';

const HOME = join(tmpdir(), `robin-v1imp-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../../data/db/migrations'));
  return db;
}

const session = 'TEST_SESSION_01HZX9YK';

test('upsertEntity: creates, then skips on re-run with same payload', async () => {
  const db = await fresh();
  const a = await upsertEntity(db, {
    name: 'B&H Photo',
    type: 'service',
    aliases: ['B&H', 'BH Photo'],
    sourcePath: 'knowledge/service-providers/bh-photo.md',
    sessionId: session,
  });
  assert.equal(a.action, 'created');
  assert.ok(a.id);
  assert.ok(await hashExists(db, a.hash));

  const b = await upsertEntity(db, {
    name: 'B&H Photo',
    type: 'service',
    aliases: ['B&H', 'BH Photo'],
    sourcePath: 'knowledge/service-providers/bh-photo.md',
    sessionId: session,
  });
  assert.equal(b.action, 'skipped');
  await close(db);
});

test('upsertEntity: merging aliases produces a single row, deduped', async () => {
  const db = await fresh();
  await upsertEntity(db, {
    name: 'Joony',
    type: 'person',
    aliases: ['Jake', 'brother'],
    sourcePath: 'profile/people/jake-lee.md',
    sessionId: session,
  });
  // Different aliases, same (type, name) — second call merges.
  const second = await upsertEntity(db, {
    name: 'Joony',
    type: 'person',
    aliases: ['brother', 'Jake Lee'], // overlap + new
    sourcePath: 'profile/people/jake-lee.md',
    sessionId: session,
  });
  assert.equal(second.action, 'merged');
  const [rows] = await db
    .query('SELECT id, name, type, meta FROM entities WHERE name = "Joony"')
    .collect();
  assert.equal(rows.length, 1);
  assert.deepEqual([...rows[0].meta.aliases].sort(), ['Jake', 'Jake Lee', 'brother']);
  await close(db);
});

test('createMemo: creates, then skips on re-run; stamps provenance in meta', async () => {
  const db = await fresh();
  const a = await createMemo(db, {
    kind: 'knowledge',
    content: 'Recipes — kimchi jjigae is a Korean stew.',
    confidence: 0.9,
    sourcePath: 'knowledge/recipes.md',
    sessionId: session,
  });
  assert.equal(a.action, 'created');
  const [rows] = await db.query('SELECT meta FROM memos').collect();
  assert.equal(rows[0].meta.imported_from, 'v1');
  assert.equal(rows[0].meta.v1_source_path, 'knowledge/recipes.md');

  const b = await createMemo(db, {
    kind: 'knowledge',
    content: 'Recipes — kimchi jjigae is a Korean stew.',
    confidence: 0.9,
    sourcePath: 'knowledge/recipes.md',
    sessionId: session,
  });
  assert.equal(b.action, 'skipped');
  await close(db);
});

test('createMemo: findByPath returns the most recent ledger entry', async () => {
  const db = await fresh();
  const first = await createMemo(db, {
    kind: 'knowledge',
    content: 'v1 content',
    sourcePath: 'knowledge/foo.md',
    sessionId: session,
  });
  const ledger = await findByPath(db, 'knowledge/foo.md');
  assert.equal(ledger.hash, first.hash);
  assert.equal(ledger.kind, 'memo');
  await close(db);
});

test('upsertEdge: creates an `about` edge and is idempotent', async () => {
  const db = await fresh();
  const entity = await upsertEntity(db, {
    name: 'Google',
    type: 'service',
    sourcePath: 'knowledge/service-providers/google.md',
    sessionId: session,
  });
  const memo = await createMemo(db, {
    kind: 'knowledge',
    content: 'Google is a search and ads company.',
    sourcePath: 'knowledge/service-providers/google.md',
    sessionId: session,
  });
  const e1 = await upsertEdge(db, { from: memo.id, to: entity.id, kind: 'about' });
  const e2 = await upsertEdge(db, { from: memo.id, to: entity.id, kind: 'about' });
  assert.equal(e1.action, 'upserted');
  assert.equal(e2.action, 'upserted');
  const [rows] = await db.query('SELECT id FROM edges WHERE kind = "about"').collect();
  assert.equal(rows.length, 1, 'second upsert should not produce a duplicate row');
  await close(db);
});

test('upsertEdge: mentions edge with context accumulates contexts on repeat', async () => {
  const db = await fresh();
  const target = await upsertEntity(db, {
    name: 'Google',
    type: 'service',
    sourcePath: 'knowledge/service-providers/google.md',
    sessionId: session,
  });
  const source = await createMemo(db, {
    kind: 'knowledge',
    content: 'A browser-history memo referencing Google.',
    sourcePath: 'knowledge/browser/recent.md',
    sessionId: session,
  });
  await upsertEdge(db, { from: source.id, to: target.id, kind: 'mentions', context: 'google' });
  await upsertEdge(db, {
    from: source.id,
    to: target.id,
    kind: 'mentions',
    context: 'google search',
  });
  await upsertEdge(db, { from: source.id, to: target.id, kind: 'mentions', context: 'google' });
  const [rows] = await db.query('SELECT meta FROM edges WHERE kind = "mentions"').collect();
  assert.equal(rows.length, 1);
  const ctxs = rows[0]?.meta?.contexts ?? [];
  assert.deepEqual([...ctxs].sort(), ['google', 'google search']);
  await close(db);
});

test('createEvent: creates with biographed_at = NULL, then skips on re-run', async () => {
  const db = await fresh();
  const ts = new Date('2026-04-30T00:00:00Z');
  const a = await createEvent(db, {
    source: 'v1-journal',
    content: 'Imported journal day content.',
    ts,
    sourcePath: 'memory/streams/journal.md',
    sessionId: session,
  });
  assert.equal(a.action, 'created');
  const [rows] = await db.query('SELECT biographed_at, dreamed_at FROM events').collect();
  // option<datetime> field, never set: SDK returns undefined (or null on some
  // versions). Either is acceptable; what matters is that it's NOT a datetime.
  assert.ok(!rows[0].biographed_at, 'biographed_at should be unset');
  assert.ok(!rows[0].dreamed_at, 'dreamed_at should be unset');

  const b = await createEvent(db, {
    source: 'v1-journal',
    content: 'Imported journal day content.',
    ts,
    sourcePath: 'memory/streams/journal.md',
    sessionId: session,
  });
  assert.equal(b.action, 'skipped');
  await close(db);
});

test('createRule: defaults to kind=behavior, active=true', async () => {
  const db = await fresh();
  const r = await createRule(db, {
    content: 'Be terse.',
    sourcePath: 'memory/self-improvement/preferences.md',
    sessionId: session,
  });
  assert.equal(r.action, 'created');
  const [rows] = await db.query('SELECT kind, active FROM rules').collect();
  assert.equal(rows[0].kind, 'behavior');
  assert.equal(rows[0].active, true);
  await close(db);
});

test('createRefusal: defaults to inbound direction', async () => {
  const db = await fresh();
  await createRefusal(db, {
    content: 'quarantined content',
    sourcePath: 'memory/quarantine/example.md',
    sessionId: session,
  });
  const [rows] = await db.query('SELECT direction, reason, meta FROM refusals').collect();
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].reason, 'v1-quarantine');
  assert.equal(rows[0].meta.from_v1, true);
  await close(db);
});

test('applyFacet: writes a profile_facet memo AND the persona structured field', async () => {
  const db = await fresh();
  const r = await applyFacet(db, {
    facet_slug: 'identity',
    body: '- **Name:** Kevin K Lee\n- **Pronouns:** he/him',
    sourcePath: 'memory/profile/identity.md',
    sessionId: session,
  });
  assert.equal(r.memo.action, 'created');
  assert.equal(r.persona_action, 'written');
  const [memos] = await db
    .query('SELECT kind, meta FROM memos WHERE meta.facet_slug = "identity"')
    .collect();
  assert.equal(memos.length, 1);
  assert.equal(memos[0].kind, 'profile_facet');
  const [persona] = await db.query('SELECT name, pronouns FROM persona:singleton').collect();
  assert.equal(persona[0].name, 'Kevin K Lee');
  assert.equal(persona[0].pronouns, 'he/him');
  await close(db);
});
