import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../_runtime/context.ts';
import { integration as github, actions } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-gh-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('github: tick skips when GITHUB_TOKEN is missing', async () => {
  const db = freshDb();
  const ctx = buildContext('github', db, null);
  const oldToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const r = await github.tick!(ctx);
  if (oldToken) process.env.GITHUB_TOKEN = oldToken;
  assert.equal(r.status, 'skipped');
  closeDb(db);
});

test('github: tick ingests new notifications and dedupes by id', async () => {
  const db = freshDb();
  const ctx = buildContext('github', db, null);
  process.env.GITHUB_TOKEN = 'fake-token';
  // First call returns 2 notifications
  let callCount = 0;
  ctx.fetch = (async (_url: string, opts: { headers?: Record<string, string> }) => {
    callCount++;
    assert.match(opts.headers!.Authorization, /Bearer fake-token/);
    if (callCount === 1) {
      return new Response(JSON.stringify([
        { id: 'n1', subject: { title: 'PR #42', type: 'PullRequest' }, repository: { full_name: 'kevin/robin' }, unread: true, reason: 'mention', updated_at: '2026-05-19T10:00:00Z' },
        { id: 'n2', subject: { title: 'Issue #7', type: 'Issue' }, repository: { full_name: 'kevin/photo-tools' }, unread: true, reason: 'assign', updated_at: '2026-05-19T10:05:00Z' },
      ]), { status: 200 });
    }
    return new Response(JSON.stringify([
      { id: 'n2', subject: { title: 'Issue #7', type: 'Issue' }, repository: { full_name: 'kevin/photo-tools' }, unread: true, reason: 'assign', updated_at: '2026-05-19T10:05:00Z' },
      { id: 'n3', subject: { title: 'PR #43', type: 'PullRequest' }, repository: { full_name: 'kevin/robin' }, unread: true, reason: 'review_requested', updated_at: '2026-05-19T11:00:00Z' },
    ]), { status: 200 });
  }) as typeof fetch;
  const r1 = await github.tick!(ctx);
  assert.equal(r1.status, 'ok');
  assert.equal(r1.ingested, 2);
  const r2 = await github.tick!(ctx);
  assert.equal(r2.status, 'ok');
  assert.equal(r2.ingested, 1); // only n3 is new; n2 was deduped
  delete process.env.GITHUB_TOKEN;
  closeDb(db);
});

test('github: health is unhealthy without token', async () => {
  const db = freshDb();
  const ctx = buildContext('github', db, null);
  delete process.env.GITHUB_TOKEN;
  const h = await github.health!(ctx);
  assert.equal(h.ok, false);
  closeDb(db);
});

test('github: actions.recent_activity resolves username and fetches events', async () => {
  const db = freshDb();
  const ctx = buildContext('github', db, null);
  process.env.GITHUB_TOKEN = 'fake';
  let calls: string[] = [];
  ctx.fetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'kevin', name: 'Kevin' }), { status: 200 });
    return new Response(JSON.stringify([
      { id: 'e1', type: 'PushEvent', repo: { name: 'kevin/robin' }, payload: {}, created_at: '2026-05-19T10:00:00Z' },
    ]), { status: 200 });
  }) as typeof fetch;
  const events = await actions.recent_activity({ limit: 5 }, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'PushEvent');
  assert.ok(calls.some((c) => c.endsWith('/user')));
  assert.ok(calls.some((c) => c.includes('/users/kevin/events')));
  // Second call should NOT re-resolve the username (uses cache)
  calls = [];
  await actions.recent_activity({}, ctx);
  assert.ok(!calls.some((c) => c.endsWith('/user')));
  delete process.env.GITHUB_TOKEN;
  closeDb(db);
});
