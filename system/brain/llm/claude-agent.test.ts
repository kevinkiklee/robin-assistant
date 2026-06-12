import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { RunSdkInput, SdkResult } from '../../agent/sdk.ts';
import { UsageLedger } from '../../agent/usage-ledger.ts';
import type { RobinDb } from '../memory/db.ts';
import { migration011 } from '../memory/migrations/011-agent-usage.ts';
import { ClaudeAgentProvider, SubscriptionLimitError } from './claude-agent.ts';

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
  // SDK contract: { type: 'json_schema', schema } — a bare schema is silently ignored.
  assert.equal(outputFormat.type, 'json_schema');
  assert.equal(outputFormat.schema?.type, 'object');
  assert.ok(outputFormat.schema?.properties?.answer);
  // zod's "$schema" marker also silently disables structured output — must be stripped.
  assert.equal('$schema' in outputFormat.schema, false);
  // Structured output needs turn headroom; maxTurns:1 (and even 2) cuts it off.
  assert.ok(((seen as any)?.maxTurns ?? 0) >= 4);
});

test('ClaudeAgentProvider: threads SdkResult.structured through to InvokeResult', async () => {
  const structured = { verdicts: [{ id: 'bc1', verdict: 'reject' }] };
  const provider = new ClaudeAgentProvider({
    runSdk: async () => ({ ...okResult, text: '', structured }),
  });
  const res = await provider.invoke({ messages: [{ role: 'user', content: 'adjudicate' }] });
  assert.deepEqual(res.structured, structured);

  // No structured output requested → field stays absent, not undefined-valued.
  const plain = new ClaudeAgentProvider({ runSdk: async () => okResult });
  const res2 = await plain.invoke({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('structured' in res2, false);
});

// ─── Subscription usage-limit detection ──────────────────────────────────────
// When the subscription account is rate/usage-limited, the SDK does NOT error —
// it returns status:'success' whose text is the limit banner (observed live
// 2026-06-12: "You've hit your Sonnet limit · resets Jun 15 at 7am
// (America/New_York)"). Passing that banner through as model output poisons
// every downstream JSON parse and reads as bad output instead of an outage.

test('ClaudeAgentProvider: throws SubscriptionLimitError when the SDK returns a usage-limit banner', async () => {
  const provider = new ClaudeAgentProvider({
    runSdk: async () => ({
      ...okResult,
      text: "You've hit your Sonnet limit · resets Jun 15 at 7am (America/New_York)",
    }),
  });

  await assert.rejects(
    provider.invoke({ messages: [{ role: 'user', content: 'extract' }] }),
    (err: unknown) => {
      assert.ok(err instanceof SubscriptionLimitError, 'throws the typed limit error');
      // Message must read as an outage to downstream classifiers AND preserve
      // the banner (it carries the reset time, useful in logs/alerts).
      assert.match((err as Error).message, /subscription limit/i);
      assert.match((err as Error).message, /Sonnet limit/);
      return true;
    },
  );
});

test('ClaudeAgentProvider: limit banner with curly apostrophe and different model name is detected', async () => {
  const provider = new ClaudeAgentProvider({
    runSdk: async () => ({
      ...okResult,
      text: 'You’ve hit your usage limit · resets 3pm',
    }),
  });
  await assert.rejects(
    provider.invoke({ messages: [{ role: 'user', content: 'x' }] }),
    SubscriptionLimitError,
  );
});

test('ClaudeAgentProvider: a real reply mentioning limits is NOT mistaken for the banner', async () => {
  // Long-form prose that merely discusses usage limits must pass through; only
  // the short leading banner shape is an outage.
  const prose =
    "You've hit your stride this week — the journal shows steady output. One caution: the daily spend " +
    'limit on the dispatcher tripped twice, which suggests the cap is tuned too low for current volume. ' +
    'Consider raising it after reviewing the ledger.';
  const provider = new ClaudeAgentProvider({ runSdk: async () => ({ ...okResult, text: prose }) });
  const res = await provider.invoke({ messages: [{ role: 'user', content: 'reflect' }] });
  assert.equal(res.text, prose);
});

test('ClaudeAgentProvider: structured output present bypasses banner detection', async () => {
  // If the SDK parked structured output on the result, the call genuinely
  // succeeded regardless of what the text channel contains.
  const provider = new ClaudeAgentProvider({
    runSdk: async () => ({
      ...okResult,
      text: "You've hit your Sonnet limit · resets Jun 15 at 7am",
      structured: { answer: 'ok' },
    }),
  });
  const res = await provider.invoke({
    messages: [{ role: 'user', content: 'x' }],
    outputSchema: z.object({ answer: z.string() }),
  });
  assert.deepEqual(res.structured, { answer: 'ok' });
});
