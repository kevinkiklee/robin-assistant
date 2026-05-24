import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RobinDb } from '../brain/memory/db.ts';
import { migration011 } from '../brain/memory/migrations/011-agent-usage.ts';
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

function fakeLedger(): { ledger: UsageLedger; close: () => void } {
  const db = new Database(':memory:') as unknown as RobinDb;
  migration011.up(db);
  return { ledger: new UsageLedger(db), close: () => db.close() };
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
    runAgent: async (input, deps) => {
      captured = { input, cap: deps.cap };
      return okResult;
    },
  });
  assert.equal(r.status, 'success');
  assert.equal(r.exitCode, 0);
  assert.equal(captured.input?.surface, 'agentic-autonomous');
  assert.equal(captured.cap, 25, 'cap must be agentic_autonomous_daily_usd');
  // The handler's own build() ran — B is read-only research (plan mode).
  assert.equal(captured.input?.permissionMode, 'plan');
  assert.ok((captured.input?.goal.length ?? 0) > 0, 'a default goal should be supplied');
  // B's allowlist is built-in tools only (WebSearch/WebFetch/Read) → no MCP servers.
  assert.deepEqual(captured.input?.mcpServers, {});
});

test('runRunnerEntry: --goal overrides the default goal', async () => {
  let goal = '';
  await runRunnerEntry(['--handler=B', '--goal=look into X'], {
    userDataDir: tmpUserData(),
    repoRoot: '/repo',
    log: () => {},
    openLedger: fakeLedger,
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
    runAgent: async () => ({ ...okResult, status: 'error', summary: 'boom' }),
  });
  assert.equal(r.status, 'error');
  assert.equal(r.exitCode, 1);
});
