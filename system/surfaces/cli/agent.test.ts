import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RunAgentInput, RunAgentResult } from '../../agent/run-agent.ts';
import { UsageLedger } from '../../agent/usage-ledger.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { migration011 } from '../../brain/memory/migrations/011-agent-usage.ts';
import { createWorktree, parseAgentArgs, runAgentCli, writeLearningRecord } from './agent.ts';

/** A user-data dir with a minimal policies.yaml so loadPolicies returns defaults. */
function tmpUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-agent-cli-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'policies.yaml'),
    'agent:\n  caps:\n    agentic_on_demand_daily_usd: 50\n',
  );
  return dir;
}

function fakeLedger(): { ledger: UsageLedger; close: () => void } {
  const db = new Database(':memory:') as unknown as RobinDb;
  migration011.up(db);
  return { ledger: new UsageLedger(db), close: () => db.close() };
}

const okResult: RunAgentResult = {
  status: 'success',
  summary: 'all done',
  turns: 3,
  usage: { inputTokens: 100, outputTokens: 20 },
  costUsd: 0.12,
};

/**
 * Fake MCP-server resolver injected so tests never resolve the real CLI binary
 * (no `pnpm build` needed). Returns the robin / robin-extension configs the
 * handler's allowlist references; built-in-only handlers get {}.
 */
const fakeMcpServers: typeof import('../../agent/mcp-servers.ts')['mcpServersForRun'] = (
  allowedTools,
) => {
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

test('parseAgentArgs: goal + handler + flags', () => {
  const a = parseAgentArgs(['fix the bug', '--handler=A', '--max-turns=10', '--budget=2']);
  assert.equal(a.goal, 'fix the bug');
  assert.equal(a.handler, 'A');
  assert.equal(a.maxTurns, 10);
  assert.equal(a.budget, 2);
  assert.equal(a.write, false);
});

test('parseAgentArgs: --write defaults handler to A', () => {
  const a = parseAgentArgs(['do it', '--write']);
  assert.equal(a.write, true);
  assert.equal(a.handler, 'A');
});

test('parseAgentArgs: no handler + no --write leaves handler empty', () => {
  const a = parseAgentArgs(['just research']);
  assert.equal(a.handler, '');
});

test('parseAgentArgs: handler is upper-cased + cwd parsed', () => {
  const a = parseAgentArgs(['g', '--handler=i', '--cwd=/some/path']);
  assert.equal(a.handler, 'I');
  assert.equal(a.cwd, '/some/path');
});

// ── autonomous-handler rejection ─────────────────────────────────────────────

test('runAgentCli: rejects autonomous handler (K) without --force', async () => {
  let called = false;
  const r = await runAgentCli(['remediate', '--handler=K'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    runAgent: async () => {
      called = true;
      return okResult;
    },
    openLedger: fakeLedger,
    log: () => {},
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.message, /autonomous/);
  assert.equal(called, false, 'runAgent must not be called for a rejected autonomous handler');
});

test('runAgentCli: --force lets an autonomous handler through', async () => {
  // K is a write handler → provide a fake worktree so no real git is touched.
  let ran = false;
  const r = await runAgentCli(['remediate', '--handler=K', '--force'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    mcpServers: fakeMcpServers,
    runAgent: async () => {
      ran = true;
      return okResult;
    },
    openLedger: fakeLedger,
    createWorktree: () => ({ worktree: '/repo/.worktrees/x', branch: 'agent/x' }),
    worktreeHasChanges: () => true,
    log: () => {},
  });
  assert.equal(ran, true);
  assert.equal(r.status, 'success');
});

// ── read handler: no worktree built ──────────────────────────────────────────

test('runAgentCli: read handler (C) does not create a worktree', async () => {
  let worktreeCalls = 0;
  let seenInput: RunAgentInput | undefined;
  await runAgentCli(['triage my inbox', '--handler=C'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    mcpServers: fakeMcpServers,
    runAgent: async (input) => {
      seenInput = input;
      return okResult;
    },
    openLedger: fakeLedger,
    createWorktree: () => {
      worktreeCalls++;
      return { worktree: '/x', branch: 'b' };
    },
    log: () => {},
  });
  assert.equal(worktreeCalls, 0, 'no worktree for a read handler');
  assert.equal(seenInput?.surface, 'agentic-on-demand');
  // C's allowlist is mcp__robin-extension__* tools → that server is wired in.
  assert.deepEqual(Object.keys(seenInput?.mcpServers ?? {}), ['robin-extension']);
});

// ── worktree path construction (write handler A) ─────────────────────────────

test('runAgentCli: write handler (A) builds a worktree + passes it as cwd', async () => {
  let seenInput: RunAgentInput | undefined;
  const r = await runAgentCli(['improve', '--write'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    now: () => new Date('2026-05-24T12:00:00.000Z'),
    runAgent: async (input) => {
      seenInput = input;
      return okResult;
    },
    openLedger: fakeLedger,
    createWorktree: (repoRoot, now = () => new Date()) => {
      const ts = now().toISOString().replace(/[:.]/g, '-');
      return { worktree: join(repoRoot, '.worktrees', ts), branch: `agent/${ts}` };
    },
    worktreeHasChanges: () => true,
    log: () => {},
  });
  assert.equal(r.status, 'success');
  assert.equal(seenInput?.cwd, '/repo/.worktrees/2026-05-24T12-00-00-000Z');
  assert.equal(seenInput?.permissionMode, 'acceptEdits');
  // A is built-in tools only (Read/Glob/Grep/Edit/Write/Bash) → no MCP servers wired.
  assert.deepEqual(seenInput?.mcpServers, {});
});

test('runAgentCli: write handler prunes worktree when no changes were made', async () => {
  let pruned = false;
  await runAgentCli(['improve', '--write'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    runAgent: async () => okResult,
    openLedger: fakeLedger,
    createWorktree: () => ({ worktree: '/repo/.worktrees/x', branch: 'agent/x' }),
    worktreeHasChanges: () => false,
    pruneWorktree: () => {
      pruned = true;
    },
    log: () => {},
  });
  assert.equal(pruned, true, 'a no-change run prunes the throwaway worktree');
});

// ── learning loop for A ──────────────────────────────────────────────────────

test('runAgentCli: handler A writes a learning record under agent-runs/', async () => {
  const userDataDir = tmpUserData();
  await runAgentCli(['improve the primer', '--write'], {
    userDataDir,
    repoRoot: '/repo',
    now: () => new Date('2026-05-24T12:00:00.000Z'),
    runAgent: async () => okResult,
    openLedger: fakeLedger,
    createWorktree: () => ({ worktree: '/repo/.worktrees/x', branch: 'agent/feat' }),
    worktreeHasChanges: () => true,
    log: () => {},
  });
  const runsDir = join(userDataDir, 'agent-runs');
  const files = readdirSync(runsDir).filter((f) => f.endsWith('-A.md'));
  assert.equal(files.length, 1);
  const body = readFileSync(join(runsDir, files[0]), 'utf8');
  assert.match(body, /node_type: agent_run/);
  assert.match(body, /status: success/);
  assert.match(body, /branch: agent\/feat/);
  assert.match(body, /improve the primer/);
});

test('runAgentCli: non-A handler does NOT write a learning record', async () => {
  const userDataDir = tmpUserData();
  await runAgentCli(['triage my inbox', '--handler=C'], {
    userDataDir,
    repoRoot: '/repo',
    mcpServers: fakeMcpServers,
    runAgent: async () => okResult,
    openLedger: fakeLedger,
    log: () => {},
  });
  const runsDir = join(userDataDir, 'agent-runs');
  const files = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith('-A.md')) : [];
  assert.equal(files.length, 0);
});

// ── writeLearningRecord unit ─────────────────────────────────────────────────

test('writeLearningRecord: writes frontmatter + lives outside content/knowledge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-learn-'));
  const path = writeLearningRecord(dir, {
    handler: 'A',
    goal: 'g',
    status: 'capped',
    branch: 'agent/z',
    turns: 7,
    costUsd: 1.5,
    ts: '2026-05-24T01:02:03.000Z',
  });
  assert.ok(existsSync(path));
  assert.ok(path.includes(join('agent-runs')), 'record lives under agent-runs/');
  assert.ok(!path.includes(join('content', 'knowledge')), 'never under content/knowledge');
  const body = readFileSync(path, 'utf8');
  assert.match(body, /node_type: agent_run/);
  assert.match(body, /turns: 7/);
  assert.match(body, /cost_usd: 1.5/);
});

// ── createWorktree path construction (no git, just shape) ────────────────────

test('createWorktree: branch + path derive from the timestamp', () => {
  // Exercise path construction without invoking git by stubbing execFileSync is
  // overkill here; instead assert the helper's naming via a real temp git repo.
  const repo = mkdtempSync(join(tmpdir(), 'robin-wt-'));
  // Init a tiny repo with a main branch + one commit so `worktree add ... main` works.
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  writeFileSync(join(repo, 'f.txt'), 'x');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

  const { worktree, branch } = createWorktree(repo, () => new Date('2026-05-24T12:00:00.000Z'));
  assert.equal(branch, 'agent/2026-05-24T12-00-00-000Z');
  assert.ok(worktree.endsWith(join('.worktrees', '2026-05-24T12-00-00-000Z')));
  assert.ok(existsSync(worktree), 'worktree dir created');
});
