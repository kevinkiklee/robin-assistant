import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type RobinDb } from '../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../brain/memory/migrations/index.ts';
import type { RunAgentInput, RunAgentResult } from './run-agent.ts';
import { parseRunnerArgs, runRunnerEntry } from './runner-entry.ts';
import { UsageLedger } from './usage-ledger.ts';

/** A user-data dir with a minimal policies.yaml so loadPolicies returns the autonomous cap. */
function tmpUserData(autonomousCap = 25): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-runner-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'policies.yaml'),
    `agent:\n  caps:\n    agentic_autonomous_daily_usd: ${autonomousCap}\n`,
  );
  return dir;
}

/**
 * Fake ledger over a real in-memory DB with the FULL schema applied — the new
 * outcome columns (migration 025) and the `alerts` table (migration 024) are
 * asserted against this `db` by the Phase-B tests. Exposes the live `db` so a
 * test can seed verifier rows and read back the stamped `agent_usage`/`alerts`.
 */
function fakeLedger(): { ledger: UsageLedger; db: RobinDb; close: () => void } {
  // openDb loads sqlite-vec (migrations 005/010/023 create vec virtual tables);
  // a raw better-sqlite3 handle would fail applyMigrations with SQLITE_ERROR.
  const dir = mkdtempSync(join(tmpdir(), 'robin-runner-db-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  // `close` is a no-op so the test can read back agent_usage/alerts AFTER the
  // run; the runner calls close() in its finally, but the test owns the handle's
  // lifetime (the temp file is reaped on process exit).
  return { ledger: new UsageLedger(db), db, close: () => {} };
}

const okResult: RunAgentResult = {
  status: 'success',
  summary: 'done',
  turns: 2,
  usage: { inputTokens: 50, outputTokens: 10 },
  costUsd: 0.05,
};

/**
 * Fake MCP-server resolver injected so tests never resolve the real CLI binary
 * (no `pnpm build` needed). Returns the robin / robin-extension configs the
 * handler's allowlist references; built-in-only handlers get {}.
 */
const fakeMcpServers: typeof import('./mcp-servers.ts')['mcpServersForRun'] = (allowedTools) => {
  const out: Record<string, { type: 'stdio'; command: string; args: string[] }> = {};
  if (allowedTools.some((t) => t.startsWith('mcp__robin__'))) {
    out.robin = { type: 'stdio', command: '/r', args: ['mcp', 'core'] };
  }
  if (allowedTools.some((t) => t.startsWith('mcp__robin-extension__'))) {
    out['robin-extension'] = { type: 'stdio', command: '/r', args: ['mcp', 'extension'] };
  }
  return out;
};

// ── arg parsing ─────────────────────────────────────────────────────────────

test('parseRunnerArgs: handler is parsed + uppercased', () => {
  assert.equal(parseRunnerArgs(['--handler=b']).handler, 'B');
  assert.equal(parseRunnerArgs(['--handler=K']).handler, 'K');
});

test('parseRunnerArgs: missing handler yields empty string', () => {
  assert.equal(parseRunnerArgs([]).handler, '');
});

test('parseRunnerArgs: optional --goal override is captured', () => {
  const a = parseRunnerArgs(['--handler=B', '--goal=custom goal']);
  assert.equal(a.goal, 'custom goal');
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('runRunnerEntry: runs an autonomous handler with the autonomous surface + cap', async () => {
  let captured: { input?: RunAgentInput; cap?: number } = {};
  const r = await runRunnerEntry(['--handler=B'], {
    userDataDir: tmpUserData(25),
    repoRoot: '/repo',
    log: () => {},
    openLedger: fakeLedger,
    mcpServers: fakeMcpServers,
    runAgent: async (input, deps) => {
      captured = { input, cap: deps.cap };
      return okResult;
    },
  });
  assert.equal(r.status, 'success');
  assert.equal(r.exitCode, 0);
  assert.equal(captured.input?.surface, 'agentic-autonomous');
  assert.equal(captured.cap, 25, 'cap must be agentic_autonomous_daily_usd');
  // The handler's own build() ran — B is default mode (not plan; see b-research.ts).
  assert.equal(captured.input?.permissionMode, 'default');
  assert.ok((captured.input?.goal.length ?? 0) > 0, 'a default goal should be supplied');
  // B's allowlist includes mcp__robin-extension__ingest → robin-extension server is wired in.
  assert.deepEqual(captured.input?.mcpServers, {
    'robin-extension': { type: 'stdio', command: '/r', args: ['mcp', 'extension'] },
  });
});

test('runRunnerEntry: --goal overrides the default goal', async () => {
  let goal = '';
  await runRunnerEntry(['--handler=B', '--goal=look into X'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: fakeLedger,
    mcpServers: fakeMcpServers,
    runAgent: async (input) => {
      goal = input.goal;
      return okResult;
    },
  });
  assert.equal(goal, 'look into X');
});

test('runRunnerEntry: passes the transcriptDir under user-data/agent-runs', async () => {
  const ud = tmpUserData();
  let transcriptDir: string | undefined;
  let seenInput: RunAgentInput | undefined;
  await runRunnerEntry(['--handler=H'], {
    userDataDir: ud,
    repoRoot: '/repo',
    log: () => {},
    openLedger: fakeLedger,
    mcpServers: fakeMcpServers,
    runAgent: async (input, deps) => {
      seenInput = input;
      transcriptDir = deps.transcriptDir;
      return okResult;
    },
  });
  assert.equal(transcriptDir, join(ud, 'agent-runs'));
  // H is dream-enrich over mcp__robin__* tools → the robin core server is wired in.
  assert.deepEqual(Object.keys(seenInput?.mcpServers ?? {}), ['robin']);
});

// ── autonomous-only validation ───────────────────────────────────────────────

test('runRunnerEntry: rejects an on-demand handler (A)', async () => {
  let called = false;
  const r = await runRunnerEntry(['--handler=A'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: fakeLedger,
    runAgent: async () => {
      called = true;
      return okResult;
    },
  });
  assert.equal(called, false, 'on-demand handler must not run via the autonomous runner');
  assert.equal(r.status, 'error');
  assert.equal(r.exitCode, 2);
  assert.match(r.message, /on-demand/);
});

test('runRunnerEntry: rejects an unknown handler', async () => {
  const r = await runRunnerEntry(['--handler=Z'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: fakeLedger,
    runAgent: async () => okResult,
  });
  assert.equal(r.status, 'error');
  assert.equal(r.exitCode, 2);
  assert.match(r.message, /unknown handler/);
});

test('runRunnerEntry: missing --handler is a usage error', async () => {
  const r = await runRunnerEntry([], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: fakeLedger,
    runAgent: async () => okResult,
  });
  assert.equal(r.status, 'error');
  assert.equal(r.exitCode, 2);
});

test('runRunnerEntry: non-success run exits 1', async () => {
  const r = await runRunnerEntry(['--handler=B'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: fakeLedger,
    mcpServers: fakeMcpServers,
    runAgent: async () => ({ ...okResult, status: 'error', summary: 'boom' }),
  });
  assert.equal(r.status, 'error');
  assert.equal(r.exitCode, 1);
});

// ── Phase B: outcome persistence, verification, mismatch alert ────────────────

/**
 * Build a fakeLedger whose `db` the test keeps a handle to, and a fake `runAgent`
 * that INSERTS a real `agent_usage` row through the live ledger (mirroring how the
 * real runAgent records exactly one row) and returns its id as `ledgerId`. That
 * keeps every outcome-column assertion against the real `agent_usage` table.
 */
function ledgerWithDb() {
  const made = fakeLedger();
  return made;
}

/** A runAgent fake that records a row via the injected ledger and returns the given result fields. */
function recordingRunAgent(
  ledger: UsageLedger,
  result: Partial<RunAgentResult> & Pick<RunAgentResult, 'status'>,
  capture?: (input: RunAgentInput) => void,
): typeof import('./run-agent.ts')['runAgent'] {
  return (async (input: RunAgentInput) => {
    capture?.(input);
    const ledgerId = ledger.record({
      surface: input.surface,
      ...(input.label ? { label: input.label } : {}),
      costUsd: result.costUsd ?? okResult.costUsd,
      inputTokens: 1,
      outputTokens: 1,
      turns: result.turns ?? okResult.turns,
      status: result.status,
    });
    return {
      summary: result.summary ?? 'done',
      turns: result.turns ?? okResult.turns,
      usage: result.usage ?? okResult.usage,
      costUsd: result.costUsd ?? okResult.costUsd,
      ...(result.structured !== undefined ? { structured: result.structured } : {}),
      status: result.status,
      ledgerId,
    } as RunAgentResult;
  }) as typeof import('./run-agent.ts')['runAgent'];
}

test('autonomous run passes the handler id as the ledger label', async () => {
  const made = ledgerWithDb();
  let captured: RunAgentInput | undefined;
  await runRunnerEntry(['--handler=L'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    runAgent: recordingRunAgent(
      made.ledger,
      { status: 'success', structured: { outcome: 'no-op', impact: 'low' } },
      (i) => {
        captured = i;
      },
    ),
  });
  assert.equal(captured?.label, 'L');
});

test('did-work + verifier pass → outcome columns stamped verified', async () => {
  const made = ledgerWithDb();
  const runStart = new Date('2026-06-11T12:00:00.000Z');
  // Seed an E-satisfying row dated AFTER the run start so the verifier passes.
  made.db
    .prepare(`INSERT INTO belief_candidates (topic, claim, created_at) VALUES ('t', 'c', ?)`)
    .run('2026-06-11 12:30:00');
  await runRunnerEntry(['--handler=E'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    now: () => runStart,
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    runAgent: recordingRunAgent(made.ledger, {
      status: 'success',
      structured: { outcome: 'did-work', impact: 'low' },
    }),
  });
  const row = made.db
    .prepare(`SELECT outcome, impact, verified, structured_json FROM agent_usage WHERE label='E'`)
    .get() as Record<string, string | null>;
  assert.equal(row.outcome, 'did-work');
  assert.equal(row.verified, 'verified');
  assert.equal(row.impact, 'low');
  assert.ok(row.structured_json, 'structured_json must be persisted');
});

test('did-work + verifier fail → outcome-mismatch + Phase-A alert', async () => {
  const made = ledgerWithDb();
  // No belief_candidates / corrections rows → E's verifier fails.
  await runRunnerEntry(['--handler=E'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    runAgent: recordingRunAgent(made.ledger, {
      status: 'success',
      structured: { outcome: 'did-work', impact: 'low' },
    }),
  });
  const row = made.db.prepare(`SELECT verified FROM agent_usage WHERE label='E'`).get() as {
    verified: string | null;
  };
  assert.equal(row.verified, 'outcome-mismatch');
  const alert = made.db
    .prepare(
      `SELECT * FROM alerts WHERE source='agent-runner' AND key='outcome-mismatch:E' AND resolved_at IS NULL`,
    )
    .get() as { severity: string } | undefined;
  assert.ok(alert, 'an open outcome-mismatch alert must exist');
  assert.equal(alert?.severity, 'warning');
});

test('missing/invalid structured output → outcome=unparseable, no alert', async () => {
  const made = ledgerWithDb();
  await runRunnerEntry(['--handler=E'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    runAgent: recordingRunAgent(made.ledger, { status: 'success', structured: undefined }),
  });
  const row = made.db
    .prepare(`SELECT outcome, verified FROM agent_usage WHERE label='E'`)
    .get() as { outcome: string; verified: string | null };
  assert.equal(row.outcome, 'unparseable');
  assert.equal(row.verified, null, 'unparseable runs are not verified');
  const alerts = made.db.prepare(`SELECT COUNT(*) AS n FROM alerts`).get() as { n: number };
  assert.equal(alerts.n, 0, 'no alert for an unparseable outcome');
});

test('no-op runs skip the learning record; did-work runs write one', async () => {
  // no-op → no agent-runs/*-E.md file written.
  const noopUd = tmpUserData();
  const noopLedger = ledgerWithDb();
  const noopStart = new Date('2026-06-11T13:00:00.000Z');
  await runRunnerEntry(['--handler=E'], {
    userDataDir: noopUd,
    repoRoot: '/repo',
    now: () => noopStart,
    log: () => {},
    openLedger: () => noopLedger,
    mcpServers: fakeMcpServers,
    runAgent: recordingRunAgent(noopLedger.ledger, {
      status: 'success',
      structured: { outcome: 'no-op', impact: 'low' },
    }),
  });
  const noopSlug = noopStart.toISOString().replace(/[:.]/g, '-');
  assert.equal(
    existsSync(join(noopUd, 'agent-runs', `${noopSlug}-E.md`)),
    false,
    'a no-op run must NOT write a learning record',
  );

  // did-work (verifier passes) → a learning record exists with the outcome in frontmatter.
  const workUd = tmpUserData();
  const workLedger = ledgerWithDb();
  const workStart = new Date('2026-06-11T14:00:00.000Z');
  workLedger.db
    .prepare(`INSERT INTO belief_candidates (topic, claim, created_at) VALUES ('t', 'c', ?)`)
    .run('2026-06-11 14:30:00');
  await runRunnerEntry(['--handler=E'], {
    userDataDir: workUd,
    repoRoot: '/repo',
    now: () => workStart,
    log: () => {},
    openLedger: () => workLedger,
    mcpServers: fakeMcpServers,
    runAgent: recordingRunAgent(workLedger.ledger, {
      status: 'success',
      structured: { outcome: 'did-work', impact: 'low' },
    }),
  });
  const workSlug = workStart.toISOString().replace(/[:.]/g, '-');
  const recPath = join(workUd, 'agent-runs', `${workSlug}-E.md`);
  assert.equal(existsSync(recPath), true, 'a did-work run must write a learning record');
  const body = readFileSync(recPath, 'utf8');
  assert.match(body, /outcome: did-work/);
  assert.match(body, /verified: verified/);
});

test('L records verified=unverifiable on did-work', async () => {
  const made = ledgerWithDb();
  const ud = tmpUserData();
  const start = new Date('2026-06-11T15:00:00.000Z');
  await runRunnerEntry(['--handler=L'], {
    userDataDir: ud,
    repoRoot: '/repo',
    now: () => start,
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    runAgent: recordingRunAgent(made.ledger, {
      status: 'success',
      structured: { outcome: 'did-work', impact: 'low' },
    }),
  });
  const row = made.db.prepare(`SELECT verified FROM agent_usage WHERE label='L'`).get() as {
    verified: string | null;
  };
  assert.equal(row.verified, 'unverifiable');
  const alerts = made.db.prepare(`SELECT COUNT(*) AS n FROM alerts`).get() as { n: number };
  assert.equal(alerts.n, 0, 'unverifiable is not a mismatch — no alert');
});

test('write-to-repo handler (K) gets a worktree; unchanged → pruned, changed → kept', async () => {
  // K, no worktree changes → pruneWorktree called.
  const made = ledgerWithDb();
  let created = 0;
  let pruned = 0;
  await runRunnerEntry(['--handler=K'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    createWorktree: () => {
      created++;
      return { worktree: '/repo/.worktrees/wt1', branch: 'agent/wt1' };
    },
    pruneWorktree: () => {
      pruned++;
    },
    worktreeHasChanges: () => false,
    runAgent: recordingRunAgent(made.ledger, {
      status: 'success',
      structured: { outcome: 'did-work', impact: 'low' },
    }),
  });
  assert.equal(created, 1, 'K is a write-to-repo handler → a worktree is created');
  assert.equal(pruned, 1, 'no changes → the worktree is pruned');

  // E is NOT a write-to-repo handler → no worktree at all.
  const eLedger = ledgerWithDb();
  let eCreated = 0;
  await runRunnerEntry(['--handler=E'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => eLedger,
    mcpServers: fakeMcpServers,
    createWorktree: () => {
      eCreated++;
      return { worktree: '/x', branch: 'b' };
    },
    pruneWorktree: () => {},
    worktreeHasChanges: () => false,
    runAgent: recordingRunAgent(eLedger.ledger, {
      status: 'success',
      structured: { outcome: 'no-op', impact: 'low' },
    }),
  });
  assert.equal(eCreated, 0, 'E (cwd=repoRoot but default mode) must not get a worktree');

  // K WITH changes → branch reported, NOT pruned, learning record carries the branch.
  const keepLedger = ledgerWithDb();
  const keepUd = tmpUserData();
  const keepStart = new Date('2026-06-11T16:00:00.000Z');
  let keptPruned = 0;
  await runRunnerEntry(['--handler=K'], {
    userDataDir: keepUd,
    repoRoot: '/repo',
    now: () => keepStart,
    log: () => {},
    openLedger: () => keepLedger,
    mcpServers: fakeMcpServers,
    createWorktree: () => ({ worktree: '/repo/.worktrees/wt2', branch: 'agent/wt2' }),
    pruneWorktree: () => {
      keptPruned++;
    },
    worktreeHasChanges: () => true,
    runAgent: recordingRunAgent(keepLedger.ledger, {
      status: 'success',
      structured: { outcome: 'did-work', impact: 'low' },
    }),
  });
  assert.equal(keptPruned, 0, 'a worktree with changes must NOT be pruned');
  const keepSlug = keepStart.toISOString().replace(/[:.]/g, '-');
  const keepBody = readFileSync(join(keepUd, 'agent-runs', `${keepSlug}-K.md`), 'utf8');
  assert.match(
    keepBody,
    /branch: agent\/wt2/,
    'the kept branch is recorded in the learning record',
  );
  // K's verifier (worktree + hasChanges=true) passes → verified.
  const kRow = keepLedger.db.prepare(`SELECT verified FROM agent_usage WHERE label='K'`).get() as {
    verified: string | null;
  };
  assert.equal(kRow.verified, 'verified');
});

test('pre-flight capped run (no ledgerId) skips outcome persistence without crashing', async () => {
  const made = ledgerWithDb();
  const ud = tmpUserData();
  const r = await runRunnerEntry(['--handler=E'], {
    userDataDir: ud,
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    // capped pre-flight: no ledger row inserted, ledgerId undefined.
    runAgent: async () => ({
      status: 'capped',
      summary: '',
      turns: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
    }),
  });
  assert.equal(r.status, 'capped');
  assert.equal(r.exitCode, 0);
  // No agent_usage row was inserted (the fake didn't record one) → nothing to stamp.
  const n = made.db.prepare(`SELECT COUNT(*) AS n FROM agent_usage`).get() as { n: number };
  assert.equal(n.n, 0, 'capped pre-flight inserts no row and recordOutcome must not crash');
  // ledgerId === undefined means the SDK was never spawned — nothing ran, nothing
  // to record. The agent-runs dir must contain no *-E.md learning record file.
  const agentRunsDir = join(ud, 'agent-runs');
  const cappedFiles = existsSync(agentRunsDir)
    ? (await import('node:fs')).readdirSync(agentRunsDir).filter((f: string) => f.endsWith('-E.md'))
    : [];
  assert.equal(
    cappedFiles.length,
    0,
    'a pre-flight-capped run must NOT write a learning record (ledgerId === undefined means SDK was never spawned)',
  );
});
