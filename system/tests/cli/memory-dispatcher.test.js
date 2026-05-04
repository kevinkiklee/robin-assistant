// Smoke-level coverage for the `robin memory <op>` dispatcher.
// Exercises the help/unknown-op surface only; the actual op modules are
// invoked via subprocess at runtime (see system/scripts/cli/memory.js) and
// are covered by their own tests under system/tests/memory/.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMemory } from '../../scripts/cli/memory.js';

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    chunks.push(typeof s === 'string' ? s : s.toString());
    return true;
  };
  try {
    return Promise.resolve(fn()).then((r) => ({ result: r, output: chunks.join('') }));
  } finally {
    process.stdout.write = original;
  }
}

function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => {
    chunks.push(typeof s === 'string' ? s : s.toString());
    return true;
  };
  try {
    return Promise.resolve(fn()).then((r) => ({ result: r, output: chunks.join('') }));
  } finally {
    process.stderr.write = original;
  }
}

describe('robin memory: dispatcher', () => {
  it('prints help with no args', async () => {
    const { result, output } = await captureStdout(() => dispatchMemory([]));
    assert.equal(result, 0);
    assert.match(output, /usage: robin memory/);
    for (const op of [
      'regenerate-links',
      'index-entities',
      'lint',
      'densify',
      'prune-preview',
      'prune-execute',
    ]) {
      assert.match(output, new RegExp(`\\b${op}\\b`), `help missing op: ${op}`);
    }
  });

  it('prints help with --help', async () => {
    const { result, output } = await captureStdout(() => dispatchMemory(['--help']));
    assert.equal(result, 0);
    assert.match(output, /usage: robin memory/);
  });

  it('prints help with -h', async () => {
    const { result, output } = await captureStdout(() => dispatchMemory(['-h']));
    assert.equal(result, 0);
    assert.match(output, /usage: robin memory/);
  });

  it('prints help with the literal "help" subcommand', async () => {
    const { result, output } = await captureStdout(() => dispatchMemory(['help']));
    assert.equal(result, 0);
    assert.match(output, /usage: robin memory/);
  });

  it('returns non-zero for unknown op', async () => {
    const { result, output } = await captureStderr(() => dispatchMemory(['not-a-real-op']));
    assert.notEqual(result, 0);
    assert.match(output, /unknown/i);
  });

  it('rejects prototype-key lookups (no crash, exit 2)', async () => {
    const { result, output } = await captureStderr(() => dispatchMemory(['__proto__']));
    assert.notEqual(result, 0);
    assert.match(output, /unknown/i);
  });

  it('spawn path: prune-preview returns a numeric exit code', { timeout: 10000 }, async () => {
    const result = await dispatchMemory(['prune-preview']);
    assert.equal(typeof result, 'number', 'spawn should resolve to a numeric exit code');
    assert.ok(result >= 0, 'exit code should be non-negative');
  });
});
