import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJsonArrayState } from './state-helpers.ts';
import type { IntegrationContext } from './types.ts';

interface FakeLog {
  warns: Array<{ obj: unknown; msg?: string }>;
}

function fakeCtx(stateMap: Map<string, string>): { ctx: IntegrationContext; log: FakeLog } {
  const log: FakeLog = { warns: [] };
  const ctx = {
    state: {
      get: (k: string) => stateMap.get(k) ?? null,
      set: (k: string, v: string) => {
        stateMap.set(k, v);
      },
    },
    log: {
      info: () => {},
      warn: (obj: unknown, msg?: string) => {
        log.warns.push({ obj, msg });
      },
      error: () => {},
    },
  } as unknown as IntegrationContext;
  return { ctx, log };
}

test('readJsonArrayState: returns [] when key is missing — no warn', () => {
  const { ctx, log } = fakeCtx(new Map());
  const out = readJsonArrayState<string>(ctx, 'seen_ids');
  assert.deepEqual(out, []);
  assert.equal(log.warns.length, 0);
});

test('readJsonArrayState: parses a well-formed JSON array', () => {
  const { ctx } = fakeCtx(new Map([['seen_ids', '["a","b","c"]']]));
  const out = readJsonArrayState<string>(ctx, 'seen_ids');
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('readJsonArrayState: returns [] + warns when JSON is malformed', () => {
  const { ctx, log } = fakeCtx(new Map([['seen_ids', 'not-json-at-all']]));
  const out = readJsonArrayState<string>(ctx, 'seen_ids');
  assert.deepEqual(out, []);
  assert.equal(log.warns.length, 1);
  assert.deepEqual(log.warns[0].obj, { key: 'seen_ids' });
});

test('readJsonArrayState: returns [] + warns when value parses to an object', () => {
  const { ctx, log } = fakeCtx(new Map([['seen_ids', '{"not":"an array"}']]));
  const out = readJsonArrayState<string>(ctx, 'seen_ids');
  assert.deepEqual(out, []);
  assert.equal(log.warns.length, 1);
  assert.equal(
    (log.warns[0].obj as { actual: string }).actual,
    'object',
    'warn should include the actual type for debugging',
  );
});

test('readJsonArrayState: parses arrays of arbitrary shape (typed)', () => {
  const { ctx } = fakeCtx(new Map([['k', '[{"id":1},{"id":2}]']]));
  const out = readJsonArrayState<{ id: number }>(ctx, 'k');
  assert.equal(out.length, 2);
  assert.equal(out[1].id, 2);
});

test('readJsonArrayState: empty string treated like missing (no warn)', () => {
  const { ctx, log } = fakeCtx(new Map([['k', '']]));
  const out = readJsonArrayState(ctx, 'k');
  assert.deepEqual(out, []);
  assert.equal(log.warns.length, 0);
});
