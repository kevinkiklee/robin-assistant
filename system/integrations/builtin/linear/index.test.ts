import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../_runtime/context.ts';
import { actions, integration as linear } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-linear-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

const FAKE_ISSUE = {
  id: 'iss_1',
  identifier: 'ENG-42',
  title: 'Fix the bug',
  description: 'detailed description',
  url: 'https://linear.app/x/issue/ENG-42',
  state: { name: 'In Progress', type: 'started' },
  team: { key: 'ENG', name: 'Engineering' },
  updatedAt: '2026-05-19T10:00:00Z',
};

test('linear: tick skips without LINEAR_API_KEY', async () => {
  const db = freshDb();
  const ctx = buildContext('linear', db, null);
  delete process.env.LINEAR_API_KEY;
  assert.ok(linear.tick);
  const r = await linear.tick(ctx);
  assert.equal(r.status, 'skipped');
  closeDb(db);
});

test('linear: tick ingests active issues and dedupes by id+updatedAt', async () => {
  const db = freshDb();
  const ctx = buildContext('linear', db, null);
  process.env.LINEAR_API_KEY = 'fake';
  let _callCount = 0;
  ctx.fetch = (async (url: string, opts: { headers?: Record<string, string>; body?: string }) => {
    _callCount++;
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(opts.headers?.Authorization, 'fake');
    return new Response(
      JSON.stringify({
        data: {
          viewer: {
            teamMemberships: {
              nodes: [{ team: { id: 'team-1', key: 'ENG', name: 'Engineering' } }],
            },
          },
          issues: {
            nodes: [FAKE_ISSUE],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  assert.ok(linear.tick);
  const r1 = await linear.tick(ctx);
  assert.equal(r1.status, 'ok');
  assert.equal(r1.ingested, 1);
  const r2 = await linear.tick(ctx);
  assert.equal(r2.ingested, 0); // dedup
  delete process.env.LINEAR_API_KEY;
  closeDb(db);
});

test('linear: actions.active_issues returns parsed nodes', async () => {
  const db = freshDb();
  const ctx = buildContext('linear', db, null);
  process.env.LINEAR_API_KEY = 'fake';
  ctx.fetch = (async () =>
    new Response(
      JSON.stringify({ data: { viewer: { assignedIssues: { nodes: [FAKE_ISSUE] } } } }),
      { status: 200 },
    )) as typeof fetch;
  const issues = await actions.active_issues({ limit: 5 }, ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].identifier, 'ENG-42');
  delete process.env.LINEAR_API_KEY;
  closeDb(db);
});

test('linear: tick surfaces graphql errors as thrown', async () => {
  const db = freshDb();
  const ctx = buildContext('linear', db, null);
  process.env.LINEAR_API_KEY = 'fake';
  ctx.fetch = (async () =>
    new Response(JSON.stringify({ errors: [{ message: 'rate limited' }] }), {
      status: 200,
    })) as typeof fetch;
  assert.ok(linear.tick);
  const tick = linear.tick;
  await assert.rejects(async () => tick(ctx), /rate limited/);
  delete process.env.LINEAR_API_KEY;
  closeDb(db);
});
