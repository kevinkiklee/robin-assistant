import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunAgentInput, RunAgentResult } from '../../../agent/run-agent.ts';
import type { RobinDb } from '../../../brain/memory/db.ts';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { runAgentAction } from './agent-action.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-agent-action-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** A user-data dir with a policies.yaml so loadPolicies yields the default cap. */
function tmpUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-agent-action-ud-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'policies.yaml'),
    'agent:\n  caps:\n    agentic_on_demand_daily_usd: 50\n',
  );
  return dir;
}

const okResult: RunAgentResult = {
  status: 'success',
  summary: 'sent the email',
  turns: 4,
  usage: { inputTokens: 50, outputTokens: 10 },
  costUsd: 0.08,
};

test('agent action: rejects an unknown handler', async () => {
  const db = freshDb();
  const out = await runAgentAction(
    { handler: 'Z', goal: 'x' },
    { db, userDataDir: tmpUserData(), runAgent: async () => okResult },
  );
  assert.ok('error' in out);
  assert.match(out.error, /unknown handler/);
  closeDb(db);
});

test('agent action: rejects an autonomous handler (K)', async () => {
  const db = freshDb();
  let called = false;
  const out = await runAgentAction(
    { handler: 'K', goal: 'remediate' },
    {
      db,
      userDataDir: tmpUserData(),
      runAgent: async () => {
        called = true;
        return okResult;
      },
    },
  );
  assert.ok('error' in out);
  assert.match(out.error, /autonomous/);
  assert.equal(called, false);
  closeDb(db);
});

test('agent action: handler I requires confirm:true', async () => {
  const db = freshDb();
  let called = false;
  const out = await runAgentAction(
    { handler: 'I', goal: 'book dinner' },
    {
      db,
      userDataDir: tmpUserData(),
      repoRoot: '/repo',
      runAgent: async () => {
        called = true;
        return okResult;
      },
    },
  );
  assert.ok('error' in out);
  assert.match(out.error, /confirm: true/);
  assert.equal(called, false, 'must not run an unconfirmed life action');
  closeDb(db);
});

test('agent action: handler I runs with confirm:true', async () => {
  const db = freshDb();
  let seenInput: RunAgentInput | undefined;
  const out = await runAgentAction(
    { handler: 'I', goal: 'book dinner', confirm: true },
    {
      db,
      userDataDir: tmpUserData(),
      repoRoot: '/repo',
      runAgent: async (input) => {
        seenInput = input;
        return okResult;
      },
    },
  );
  assert.ok(!('error' in out));
  assert.equal(out.status, 'success');
  assert.equal(out.summary, 'sent the email');
  assert.equal(seenInput?.surface, 'agentic-on-demand');
  closeDb(db);
});

test('agent action: on-demand handler C runs through runAgent', async () => {
  const db = freshDb();
  let seenInput: RunAgentInput | undefined;
  const out = await runAgentAction(
    { handler: 'c', goal: 'triage inbox' },
    {
      db,
      userDataDir: tmpUserData(),
      repoRoot: '/repo',
      runAgent: async (input) => {
        seenInput = input;
        return okResult;
      },
    },
  );
  assert.ok(!('error' in out));
  assert.equal(out.turns, 4);
  assert.equal(out.costUsd, 0.08);
  assert.equal(seenInput?.surface, 'agentic-on-demand');
  closeDb(db);
});
