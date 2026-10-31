import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb, type RobinDb } from '../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../brain/memory/migrations/index.ts';
import { recordAlert } from '../kernel/runtime/alert-store.ts';
import type { RunAgentInput, RunAgentResult } from './run-agent.ts';
import {
  MAX_PENDING_REVIEW_WORKTREES,
  parseRunnerArgs,
  pendingReviewNote,
  runRunnerEntry,
} from './runner-entry.ts';
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
  compactions: 0,
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

test('runRunnerEntry: --goal leads, and the handler default rides along as standing rules', async () => {
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
  assert.ok(goal.startsWith('look into X\n\n'), 'the supplied goal is the task');
  assert.match(goal, /research thread/, "B's default goal is kept as standing rules");
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

test('runRunnerEntry: default repoRoot derives from the module, not process.cwd()', async () => {
  // The daemon's launchd WorkingDirectory is user-data — the detached child
  // inherits it, so a cwd-derived repoRoot resolved every path inside user-data
  // (the 2026-07-16 fleet outage). Simulate that: chdir somewhere foreign and
  // assert the handler cwd still resolves under the REAL repo root.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const foreign = mkdtempSync(join(tmpdir(), 'robin-foreign-cwd-'));
  const prevCwd = process.cwd();
  process.chdir(foreign);
  try {
    let cwd: string | undefined;
    await runRunnerEntry(['--handler=D'], {
      userDataDir: tmpUserData(),
      // deliberately NO repoRoot injected — exercise the default resolution
      log: () => {},
      openLedger: fakeLedger,
      mcpServers: fakeMcpServers,
      runAgent: async (input) => {
        cwd = input.cwd;
        return okResult;
      },
    });
    assert.equal(cwd, join(repoRoot, 'user-data', 'content', 'knowledge'));
  } finally {
    process.chdir(prevCwd);
  }
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

test('capped run with no structured output → outcome=incomplete, not unparseable', async () => {
  const made = ledgerWithDb();
  // A max-turns/max-budget cap: the SDK never reached the structured-summary
  // turn, so `structured` is absent. This is turn/time exhaustion, distinct
  // from a 'success' run that emitted invalid JSON (which stays 'unparseable').
  await runRunnerEntry(['--handler=E'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    runAgent: recordingRunAgent(made.ledger, { status: 'capped', structured: undefined }),
  });
  const row = made.db
    .prepare(`SELECT outcome, verified FROM agent_usage WHERE label='E'`)
    .get() as { outcome: string; verified: string | null };
  assert.equal(row.outcome, 'incomplete');
  assert.equal(row.verified, null, 'incomplete runs are not verified');
  const alerts = made.db.prepare(`SELECT COUNT(*) AS n FROM alerts`).get() as { n: number };
  assert.equal(alerts.n, 0, 'no alert for an incomplete outcome');
});

test('timeout run with no structured output → outcome=incomplete', async () => {
  const made = ledgerWithDb();
  await runRunnerEntry(['--handler=E'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    runAgent: recordingRunAgent(made.ledger, { status: 'timeout', structured: undefined }),
  });
  const row = made.db.prepare(`SELECT outcome FROM agent_usage WHERE label='E'`).get() as {
    outcome: string;
  };
  assert.equal(row.outcome, 'incomplete');
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

test('a verified run resolves an open outcome-mismatch alert for the handler', async () => {
  const made = ledgerWithDb();
  const runStart = new Date('2026-06-11T17:00:00.000Z');
  // 1. Seed an OPEN outcome-mismatch alert for handler E.
  recordAlert(made.db, {
    severity: 'warning',
    source: 'agent-runner',
    key: 'outcome-mismatch:E',
    message: 'handler E claimed did-work but its verifier found no evidence',
  });
  // Confirm it is open before the run.
  const before = made.db
    .prepare(
      `SELECT resolved_at FROM alerts WHERE source='agent-runner' AND key='outcome-mismatch:E'`,
    )
    .get() as { resolved_at: string | null } | undefined;
  assert.ok(before, 'alert must be seeded');
  assert.equal(before?.resolved_at, null, 'alert must be open before the run');

  // 2. Seed an E-satisfying belief_candidates row so the verifier passes.
  made.db
    .prepare(`INSERT INTO belief_candidates (topic, claim, created_at) VALUES ('t', 'c', ?)`)
    .run('2026-06-11 17:30:00');

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

  // 3. The alert must now be resolved.
  const after = made.db
    .prepare(
      `SELECT resolved_at FROM alerts WHERE source='agent-runner' AND key='outcome-mismatch:E'`,
    )
    .get() as { resolved_at: string | null } | undefined;
  assert.ok(after, 'alert row must still exist');
  assert.notEqual(after?.resolved_at, null, 'a verified run must resolve the mismatch alert');
});

test('a pre-run throw (e.g. MCP resolution) records an error ledger row instead of dying silently', async () => {
  // Before 2026-07-16, a throw between openLedger and runAgent (buildRobinMcpEntry
  // resolving a missing dist CLI) escaped runRunnerEntry entirely: no ledger row,
  // so benching never saw a month of failures. The runner must record the failure
  // and resolve cleanly.
  const made = ledgerWithDb();
  let ran = false;
  const r = await runRunnerEntry(['--handler=E'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: () => {
      throw new Error('Cannot install MCP entry: run `pnpm build` first');
    },
    runAgent: async () => {
      ran = true;
      return okResult;
    },
  });
  assert.equal(ran, false, 'the SDK must not run after a pre-run failure');
  assert.equal(r.status, 'error');
  assert.equal(r.exitCode, 1);
  assert.match(r.message, /pnpm build/);
  const row = made.db.prepare(`SELECT status, subtype FROM agent_usage WHERE label='E'`).get() as
    | { status: string; subtype: string | null }
    | undefined;
  assert.ok(row, 'a pre-run failure must still record a ledger row (benching reads it)');
  assert.equal(row?.status, 'error');
  assert.equal(row?.subtype, 'pre-run');
});

test('a worktree-creation failure records an error ledger row', async () => {
  const made = ledgerWithDb();
  const r = await runRunnerEntry(['--handler=K'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    createWorktree: () => {
      throw new Error('git worktree add failed');
    },
    pruneWorktree: () => {},
    worktreeHasChanges: () => false,
    runAgent: async () => okResult,
  });
  assert.equal(r.status, 'error');
  assert.equal(r.exitCode, 1);
  const row = made.db.prepare(`SELECT status, subtype FROM agent_usage WHERE label='K'`).get() as
    | { status: string }
    | undefined;
  assert.ok(row, 'worktree failures must be ledger-visible too');
  assert.equal(row?.status, 'error');
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
      compactions: 0,
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

test('a worktree run that moves main raises a critical agent-escape alert', async () => {
  const made = ledgerWithDb();
  const heads = ['aaaaaaa1', 'bbbbbbb2'];
  await runRunnerEntry(['--handler=K'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    createWorktree: () => ({ worktree: '/repo/.worktrees/wt1', branch: 'agent/wt1' }),
    pruneWorktree: () => {},
    worktreeHasChanges: () => false,
    mainHead: () => heads.shift() ?? null,
    runAgent: recordingRunAgent(made.ledger, {
      status: 'success',
      structured: { outcome: 'no-op', impact: 'low' },
    }),
  });
  const alert = made.db
    .prepare(`SELECT severity, message FROM alerts WHERE key = 'agent-escape:K'`)
    .get() as { severity: string; message: string } | undefined;
  assert.equal(alert?.severity, 'critical');
  assert.match(alert?.message ?? '', /aaaaaaa → bbbbbbb/);
});

test('a worktree run that leaves main alone raises no escape alert', async () => {
  const made = ledgerWithDb();
  await runRunnerEntry(['--handler=K'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    createWorktree: () => ({ worktree: '/repo/.worktrees/wt1', branch: 'agent/wt1' }),
    pruneWorktree: () => {},
    worktreeHasChanges: () => false,
    mainHead: () => 'aaaaaaa1',
    runAgent: recordingRunAgent(made.ledger, {
      status: 'success',
      structured: { outcome: 'no-op', impact: 'low' },
    }),
  });
  const n = made.db
    .prepare(`SELECT COUNT(*) AS n FROM alerts WHERE key LIKE 'agent-escape:%'`)
    .get() as {
    n: number;
  };
  assert.equal(n.n, 0);
});

// ── review backpressure ─────────────────────────────────────────────────────

const pendingN = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    worktree: `/repo/.worktrees/p${i}`,
    branch: `agent/p${i}`,
    files: [`system/f${i}.ts`],
  }));

test('K is skipped (no worktree, no SDK, no ledger row) at the review-backlog cap', async () => {
  const made = ledgerWithDb();
  let created = 0;
  let ran = 0;
  const r = await runRunnerEntry(['--handler=K'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    pendingReviewWorktrees: () => pendingN(MAX_PENDING_REVIEW_WORKTREES),
    createWorktree: () => {
      created++;
      return { worktree: '/repo/.worktrees/wt', branch: 'agent/wt' };
    },
    pruneWorktree: () => {},
    worktreeHasChanges: () => false,
    runAgent: async () => {
      ran++;
      return okResult;
    },
  });
  assert.equal(r.status, 'capped');
  assert.equal(r.exitCode, 0, 'a backlog skip is not a failure');
  assert.match(r.message, /review backlog/);
  assert.equal(created, 0, 'no new worktree while the backlog is at the cap');
  assert.equal(ran, 0, 'no SDK spend while the backlog is at the cap');
  const rows = made.db.prepare(`SELECT COUNT(*) AS n FROM agent_usage`).get() as { n: number };
  assert.equal(rows.n, 0, 'a skip writes no ledger row, so benching never sees it');
});

test('below the cap, K runs and its goal lists the files pending branches already touch', async () => {
  const made = ledgerWithDb();
  let goal = '';
  await runRunnerEntry(['--handler=K'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    pendingReviewWorktrees: () => pendingN(MAX_PENDING_REVIEW_WORKTREES - 1),
    createWorktree: () => ({ worktree: '/repo/.worktrees/wt', branch: 'agent/wt' }),
    pruneWorktree: () => {},
    worktreeHasChanges: () => false,
    runAgent: recordingRunAgent(made.ledger, { status: 'success' }, (input) => {
      goal = input.goal;
    }),
  });
  assert.match(goal, /PENDING REVIEW/);
  assert.match(goal, /- agent\/p0: system\/f0\.ts/);
});

test('a pending-worktree listing failure fails open — K runs with no note', async () => {
  const made = ledgerWithDb();
  let goal = '';
  let created = 0;
  await runRunnerEntry(['--handler=K'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    pendingReviewWorktrees: () => {
      throw new Error('git lock');
    },
    createWorktree: () => {
      created++;
      return { worktree: '/repo/.worktrees/wt', branch: 'agent/wt' };
    },
    pruneWorktree: () => {},
    worktreeHasChanges: () => false,
    runAgent: recordingRunAgent(made.ledger, { status: 'success' }, (input) => {
      goal = input.goal;
    }),
  });
  assert.equal(created, 1);
  assert.doesNotMatch(goal, /PENDING REVIEW/);
});

test('handlers without a worktree never consult the review backlog', async () => {
  let consulted = 0;
  await runRunnerEntry(['--handler=E'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: ledgerWithDb,
    mcpServers: fakeMcpServers,
    pendingReviewWorktrees: () => {
      consulted++;
      return pendingN(MAX_PENDING_REVIEW_WORKTREES + 3);
    },
    runAgent: async () => okResult,
  });
  assert.equal(consulted, 0);
});

test('pendingReviewNote truncates long file lists', () => {
  const files = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
  const note = pendingReviewNote([{ worktree: '/w', branch: 'agent/x', files }]);
  assert.match(note, /f7\.ts \(\+3 more\)/);
  assert.doesNotMatch(note, /f8\.ts/);
});

// ── Auto-land (2026-10-31) ─────────────────────────────────────────────────────

function kLandDeps(
  made: ReturnType<typeof ledgerWithDb>,
  ud: string,
  structured: unknown,
  landed: Array<{ branch: string; title: string }>,
  after: string[],
) {
  return {
    userDataDir: ud,
    repoRoot: '/repo',
    log: () => {},
    openLedger: () => made,
    mcpServers: fakeMcpServers,
    createWorktree: () => ({ worktree: '/repo/.worktrees/wt9', branch: 'agent/wt9' }),
    pruneWorktree: () => {},
    worktreeHasChanges: () => true,
    autoLand: (o: { branch: string; title: string }) => {
      landed.push({ branch: o.branch, title: o.title });
      return {
        landed: true,
        reason: 'landed as abc1234',
        files: ['system/x.ts'],
        commit: 'abc1234',
      };
    },
    afterLand: async (r: { reason: string }) => {
      after.push(r.reason);
    },
    runAgent: recordingRunAgent(made.ledger, {
      status: 'success',
      ...(structured !== undefined ? { structured } : {}),
    }),
  };
}

test('auto-land: a verified K branch is handed to autoLand with its change summary', async () => {
  const landed: Array<{ branch: string; title: string }> = [];
  const after: string[] = [];
  const made = ledgerWithDb();
  await runRunnerEntry(
    ['--handler=K'],
    kLandDeps(
      made,
      tmpUserData(),
      {
        outcome: 'did-work',
        impact: 'medium',
        changes: [{ type: 'fix', summary: 'debounce staleness repair' }],
      },
      landed,
      after,
    ),
  );
  assert.deepEqual(landed, [{ branch: 'agent/wt9', title: 'debounce staleness repair' }]);
  assert.deepEqual(after, ['landed as abc1234']);
});

test('auto-land: off when agent.auto_land is false, and never for an unverified run', async () => {
  const off = tmpUserData();
  writeFileSync(join(off, 'config', 'policies.yaml'), 'agent:\n  auto_land: false\n');
  const landed: Array<{ branch: string; title: string }> = [];
  const after: string[] = [];
  const did = { outcome: 'did-work', impact: 'low' };
  await runRunnerEntry(['--handler=K'], kLandDeps(ledgerWithDb(), off, did, landed, after));
  assert.equal(landed.length, 0, 'policy switch disables auto-land');

  // No envelope (a capped/unparseable run) → never verified → never lands.
  await runRunnerEntry(
    ['--handler=K'],
    kLandDeps(ledgerWithDb(), tmpUserData(), undefined, landed, after),
  );
  assert.equal(landed.length, 0, 'an unverified run keeps its branch for review');
});

test('runRunnerEntry: a successful run clears the remediation request it served; a failed one keeps it', async () => {
  const { writeRemediationRequest, peekRemediationRequest } = await import(
    '../lib/remediation-request.ts'
  );
  const at = new Date().toISOString();
  for (const [status, kept] of [
    ['success', false],
    ['error', true],
  ] as const) {
    const ud = tmpUserData();
    writeRemediationRequest(ud, { date: 'd', createdAt: at, goal: 'g', attempts: 1 });
    await runRunnerEntry(['--handler=B', `--request=${at}`], {
      userDataDir: ud,
      repoRoot: '/repo',
      log: () => {},
      openLedger: fakeLedger,
      mcpServers: fakeMcpServers,
      runAgent: async () => ({ ...okResult, status }),
    });
    assert.equal(peekRemediationRequest(ud, new Date()) !== null, kept, status);
  }
});

test('runRunnerEntry: a newer request written meanwhile is not cleared', async () => {
  const { writeRemediationRequest, peekRemediationRequest } = await import(
    '../lib/remediation-request.ts'
  );
  const ud = tmpUserData();
  const newer = new Date().toISOString();
  writeRemediationRequest(ud, { date: 'd2', createdAt: newer, goal: 'newer' });
  await runRunnerEntry(['--handler=B', '--request=2000-01-01T00:00:00.000Z'], {
    userDataDir: ud,
    repoRoot: '/repo',
    log: () => {},
    openLedger: fakeLedger,
    mcpServers: fakeMcpServers,
    runAgent: async () => okResult,
  });
  assert.equal(peekRemediationRequest(ud, new Date())?.goal, 'newer');
});
