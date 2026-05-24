import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RobinDb } from '../brain/memory/db.ts';
import { migration011 } from '../brain/memory/migrations/011-agent-usage.ts';
import { type RunAgentInput, runAgent } from './run-agent.ts';
import type { SdkResult } from './sdk.ts';
import { UsageLedger } from './usage-ledger.ts';

function ledger(): { ledger: UsageLedger; db: RobinDb } {
  const db = new Database(':memory:') as unknown as RobinDb;
  migration011.up(db);
  return { ledger: new UsageLedger(db), db };
}

function tmpTranscriptDir(): string {
  return mkdtempSync(join(tmpdir(), 'robin-agent-runs-'));
}

function baseInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    surface: 'agentic-on-demand',
    goal: 'do the thing',
    cwd: '/tmp/work',
    allowedTools: ['Read'],
    permissionMode: 'default',
    maxTurns: 5,
    timeoutMs: 1000,
    maxBudgetUsd: 1,
    ...overrides,
  };
}

const okResult: SdkResult = {
  status: 'success',
  text: 'done summary',
  turns: 2,
  costUsd: 0.05,
  usage: { inputTokens: 200, outputTokens: 40 },
  raw: { type: 'result', subtype: 'success' },
};

test('runAgent: cap pre-flight returns capped WITHOUT calling the sdk', async () => {
  const { ledger: led } = ledger();
  // Spend the surface up to its cap first.
  led.record({
    surface: 'agentic-on-demand',
    costUsd: 50,
    inputTokens: 1,
    outputTokens: 1,
    turns: 1,
    status: 'success',
  });

  let called = false;
  const res = await runAgent(baseInput(), {
    ledger: led,
    cap: 50,
    transcriptDir: tmpTranscriptDir(),
    runSdk: async () => {
      called = true;
      return okResult;
    },
  });

  assert.equal(res.status, 'capped');
  assert.equal(called, false, 'sdk must not be invoked when already over cap');
});

test('runAgent: success writes a transcript file + one ledger row', async () => {
  const { ledger: led } = ledger();
  const dir = tmpTranscriptDir();

  const res = await runAgent(baseInput(), {
    ledger: led,
    cap: 50,
    transcriptDir: dir,
    now: () => new Date('2026-05-24T12:00:00.000Z'),
    runSdk: async (input) => {
      // Stream a couple messages through the transcript hook.
      input.onMessage?.({ type: 'assistant', message: { content: [{ text: 'thinking' }] } });
      input.onMessage?.({ type: 'result', subtype: 'success', result: 'done summary' });
      return okResult;
    },
  });

  assert.equal(res.status, 'success');
  assert.equal(res.summary, 'done summary');
  assert.equal(res.turns, 2);
  assert.equal(res.costUsd, 0.05);

  // Transcript file exists and holds JSONL.
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /agentic-on-demand\.jsonl$/);
  assert.ok(res.transcriptPath && existsSync(res.transcriptPath));
  const lines = readFileSync(res.transcriptPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, 'assistant');
  assert.equal(JSON.parse(lines[1]).type, 'result');

  // One ledger row recorded for the surface.
  assert.equal(led.dailyTotalUsd('agentic-on-demand'), 0.05);
});

test('runAgent: an aborted signal maps to timeout', async () => {
  const { ledger: led } = ledger();

  const res = await runAgent(baseInput({ timeoutMs: 5 }), {
    ledger: led,
    cap: 50,
    transcriptDir: tmpTranscriptDir(),
    runSdk: async (input) => {
      // Simulate the deadline firing: the abort signal trips while the sdk runs.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(input.abortSignal?.aborted, true, 'signal should be aborted by the deadline');
      // The real SDK surfaces an abort as an error result; mirror that.
      return { ...okResult, status: 'error', text: '', costUsd: 0 } as SdkResult;
    },
  });

  assert.equal(res.status, 'timeout');
});

test('runAgent: maps sdk max_turns / max_budget to capped', async () => {
  const { ledger: led } = ledger();
  const res = await runAgent(baseInput(), {
    ledger: led,
    cap: 50,
    transcriptDir: tmpTranscriptDir(),
    runSdk: async () => ({ ...okResult, status: 'max_turns' }),
  });
  assert.equal(res.status, 'capped');

  const res2 = await runAgent(baseInput(), {
    ledger: led,
    cap: 50,
    transcriptDir: tmpTranscriptDir(),
    runSdk: async () => ({ ...okResult, status: 'max_budget' }),
  });
  assert.equal(res2.status, 'capped');
});

test('runAgent: forwards canUseTool + tool/permission options to the sdk', async () => {
  const { ledger: led } = ledger();
  // biome-ignore lint/suspicious/noExplicitAny: probe shape only
  const canUseTool = (() => ({ behavior: 'deny' })) as any;

  let seenAllowed: string[] | undefined;
  let seenMode: string | undefined;
  let seenCanUse: unknown;
  await runAgent(
    baseInput({
      allowedTools: ['Read', 'Edit'],
      permissionMode: 'acceptEdits',
      canUseTool,
    }),
    {
      ledger: led,
      cap: 50,
      transcriptDir: tmpTranscriptDir(),
      runSdk: async (input) => {
        seenAllowed = input.allowedTools;
        seenMode = input.permissionMode;
        seenCanUse = input.canUseTool;
        return okResult;
      },
    },
  );

  assert.deepEqual(seenAllowed, ['Read', 'Edit']);
  assert.equal(seenMode, 'acceptEdits');
  assert.equal(seenCanUse, canUseTool);
});
