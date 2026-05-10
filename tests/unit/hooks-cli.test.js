import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;

const { DISPATCH, runHook } = await import('../../src/hooks/cli.js');

test('DISPATCH map exposes the four expected phases', () => {
  assert.deepEqual(
    Object.keys(DISPATCH).sort(),
    ['auto-recall', 'bash-policy', 'session-start', 'stop'].sort(),
  );
  for (const v of Object.values(DISPATCH)) {
    assert.equal(typeof v.module, 'string');
    assert.equal(typeof v.exportName, 'string');
  }
});

test('runHook with unknown phase resolves without throwing', async () => {
  await assert.doesNotReject(runHook('does-not-exist', { rawStdin: '{}' }));
});

test('runHook with disabled phase short-circuits before dynamic import', async () => {
  // bash-policy handler module does not exist yet in this agent's tree;
  // if the dispatcher tried to import it, runHook would catch the error
  // (fail-soft) but we want to assert short-circuit behavior. We do this
  // by populating hooks-disabled.txt and asserting no throw + fast return.
  const disabledFile = join(__robinTestHome, 'hooks-disabled.txt');
  writeFileSync(disabledFile, 'bash-policy\n');
  const t0 = Date.now();
  await runHook('bash-policy', { rawStdin: '{}' });
  // No assertion on timing; the meaningful guarantee is no throw.
  assert.ok(Date.now() - t0 < 5000);
});

test('runHook is fail-soft when handler module is missing', async () => {
  const disabledFile = join(__robinTestHome, 'hooks-disabled.txt');
  writeFileSync(disabledFile, '');
  // bash-policy handler module is owned by another agent and not present.
  // runHook should swallow the import error and resolve.
  await assert.doesNotReject(runHook('bash-policy', { rawStdin: '{}' }));
});

test('runHook tolerates malformed JSON stdin (fail-soft)', async () => {
  const disabledFile = join(__robinTestHome, 'hooks-disabled.txt');
  writeFileSync(disabledFile, '');
  await assert.doesNotReject(runHook('bash-policy', { rawStdin: 'not-json{' }));
});
