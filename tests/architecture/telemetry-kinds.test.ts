import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventKindSchemas } from '../../system/lib/telemetry/kinds.ts';

test('telemetry kinds: every kind has a zod schema', () => {
  const kinds = Object.keys(eventKindSchemas);
  assert.ok(kinds.length > 0);
  for (const kind of kinds) {
    assert.ok(eventKindSchemas[kind as keyof typeof eventKindSchemas], `${kind} has no schema`);
  }
});

test('telemetry kinds: every kind uses dot-namespaced form', () => {
  for (const kind of Object.keys(eventKindSchemas)) {
    assert.match(kind, /^[a-z_]+\.[a-z_]+$/, `kind "${kind}" should be dot.namespaced lowercase`);
  }
});
