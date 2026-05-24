import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { RunSdkInput, SdkResult } from '../../agent/sdk.ts';
import { UsageLedger } from '../../agent/usage-ledger.ts';
import type { RobinDb } from '../memory/db.ts';
import { migration011 } from '../memory/migrations/011-agent-usage.ts';
import { ClaudeAgentProvider } from './claude-agent.ts';

function ledgerDb(): RobinDb {
  const d = new Database(':memory:') as unknown as RobinDb;
  migration011.up(d);
  return d;
}

const okResult: SdkResult = {
  status: 'success',
  text: 'summary',
  turns: 1,
  costUsd: 0.02,
  usage: { inputTokens: 100, outputTokens: 20 },
  raw: null,
};

test('ClaudeAgentProvider: maps a success SdkResult to an InvokeResult', async () => {
  let seen: RunSdkInput | undefined;
  const provider = new ClaudeAgentProvider({
    model: 'claude-haiku-4-5',
    runSdk: async (input) => {
      seen = input;
      return okResult;
    },
  });

  const res = await provider.invoke({
    systemPrompt: 'be brief',
    messages: [{ role: 'user', content: 'summarize this' }],
  });

  assert.equal(res.text, 'summary');
  assert.equal(res.provider, 'claude-agent');
  assert.equal(res.usage.inputTokens, 100);
  assert.equal(res.usage.outputTokens, 20);
  // Dispatcher sums InvokeResult.costUsd into its metered cap; prepaid pool dollars
  // must NOT inflate it, so the result reports zero cost.
  assert.equal(res.costUsd, 0);

  // The provider pins the cheap model and forces subscription/pool billing with a
  // single non-agentic turn and no tools.
  assert.equal(seen?.model, 'claude-haiku-4-5');
  assert.equal(seen?.maxTurns, 1);
  assert.deepEqual(seen?.allowedTools, []);
  assert.equal(seen?.permissionMode, 'default');
  assert.equal(seen?.billToPool, true);
});

test('ClaudeAgentProvider: name + meta report zero price (pool-billed)', () => {
  const provider = new ClaudeAgentProvider({ runSdk: async () => okResult });
  assert.equal(provider.name, 'claude-agent');
  assert.equal(provider.meta.inputPricePerM, 0);
  assert.equal(provider.meta.outputPricePerM, 0);
});

test('ClaudeAgentProvider: builds the prompt from systemPrompt + messages', async () => {
  let seen: RunSdkInput | undefined;
  const provider = new ClaudeAgentProvider({
    runSdk: async (input) => {
      seen = input;
      return okResult;
    },
  });

  await provider.invoke({
    systemPrompt: 'system rules',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'second' },
    ],
  });

  assert.equal(seen?.systemPrompt, 'system rules');
  // user/assistant turns are flattened into the single-turn prompt.
  assert.match(seen?.prompt ?? '', /first/);
  assert.match(seen?.prompt ?? '', /ack/);
  assert.match(seen?.prompt ?? '', /second/);
});

test('ClaudeAgentProvider: records real cost to the ledger under surface "provider"', async () => {
  const db = ledgerDb();
  const ledger = new UsageLedger(db);
  const provider = new ClaudeAgentProvider({ ledger, runSdk: async () => okResult });

  await provider.invoke({ messages: [{ role: 'user', content: 'x' }] });

  // Real (non-zero) cost lands in the ledger even though the InvokeResult reports 0.
  assert.equal(ledger.dailyTotalUsd('provider'), 0.02);
});

test('ClaudeAgentProvider: converts a zod outputSchema to a JSON-schema outputFormat', async () => {
  let seen: RunSdkInput | undefined;
  const provider = new ClaudeAgentProvider({
    runSdk: async (input) => {
      seen = input;
      return okResult;
    },
  });

  await provider.invoke({
    messages: [{ role: 'user', content: 'x' }],
    outputSchema: z.object({ answer: z.string() }),
  });

  // biome-ignore lint/suspicious/noExplicitAny: probing the loosely-typed SDK passthrough
  const outputFormat = (seen as any)?.outputFormat;
  assert.ok(outputFormat, 'outputFormat should be set when outputSchema is present');
  assert.equal(outputFormat.type, 'object');
  assert.ok(outputFormat.properties?.answer);
});
