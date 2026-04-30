import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventLog } from '../../../user-data/scripts/lib/discord/event-log.js';

test('event log: appends one JSON line per event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-evt-'));
  const path = join(root, 'events.jsonl');
  const log = createEventLog({ path });
  await log.append({ status: 'ok', userId: '1', conversationKey: 'dm-1', latencyMs: 100 });
  await log.append({ status: 'error', userId: '1', conversationKey: 'dm-1', latencyMs: 200, error: 'boom' });
  const lines = readFileSync(path, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2);
  const e1 = JSON.parse(lines[0]);
  assert.equal(e1.status, 'ok');
  assert.ok(e1.ts, 'ts auto-stamped');
  rmSync(root, { recursive: true, force: true });
});

test('event log: never writes prompt or reply text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-evt-'));
  const path = join(root, 'events.jsonl');
  const log = createEventLog({ path });
  await log.append({ status: 'ok', userId: '1', conversationKey: 'dm-1', latencyMs: 100 });
  const raw = readFileSync(path, 'utf-8');
  for (const banned of ['"prompt"', '"reply"', '"result"', '"content"']) {
    assert.equal(raw.includes(banned), false, `event log must not contain ${banned}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('event log: read24hCost sums total_cost_usd from last 24h', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-evt-'));
  const path = join(root, 'events.jsonl');
  const log = createEventLog({ path });
  await log.append({ status: 'ok', userId: '1', conversationKey: 'dm-1', latencyMs: 100, totalCostUsd: 0.05 });
  await log.append({ status: 'ok', userId: '1', conversationKey: 'dm-1', latencyMs: 100, totalCostUsd: 0.10 });
  const total = await log.read24hCost();
  assert.equal(Math.round(total * 100) / 100, 0.15);
  rmSync(root, { recursive: true, force: true });
});
