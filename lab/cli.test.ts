import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDoctor } from './cli.ts';

test('runDoctor: five named checks, all ok', () => {
  const r = runDoctor();
  assert.equal(r.checks.length, 5);
  assert.deepEqual(
    r.checks.filter((c) => !c.ok),
    [],
  );
  assert.equal(r.ok, true);
  for (const c of r.checks) assert.ok(c.name.length > 0);
});
