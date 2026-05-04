import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchDev } from '../../scripts/cli/dev.js';

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(typeof s === 'string' ? s : s.toString()); return true; };
  try {
    return Promise.resolve(fn()).then((r) => ({ result: r, output: chunks.join('') }));
  } finally {
    process.stdout.write = original;
  }
}

function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { chunks.push(typeof s === 'string' ? s : s.toString()); return true; };
  try {
    return Promise.resolve(fn()).then((r) => ({ result: r, output: chunks.join('') }));
  } finally {
    process.stderr.write = original;
  }
}

describe('robin dev: dispatcher', () => {
  it('prints help with no args', async () => {
    const { result, output } = await captureStdout(() => dispatchDev([]));
    assert.equal(result, 0);
    assert.match(output, /usage: robin dev/);
    for (const op of [
      'measure-tokens', 'measure-prefix-bloat', 'check-plugin-prefix',
      'check-protocol-triggers', 'check-doc-paths', 'golden-session',
      'tool-call-stats', 'migrate-auto-memory', 'reset', 'analyze-finances',
    ]) {
      assert.match(output, new RegExp(`\\b${op.replace(/-/g, '\\-')}\\b`), `dev help missing op: ${op}`);
    }
  });

  it('prints help with --help', async () => {
    const { result, output } = await captureStdout(() => dispatchDev(['--help']));
    assert.equal(result, 0);
    assert.match(output, /usage: robin dev/);
  });

  it('returns non-zero for unknown op', async () => {
    const { result, output } = await captureStderr(() => dispatchDev(['not-real']));
    assert.notEqual(result, 0);
    assert.match(output, /unknown/i);
  });

  it('rejects prototype-key lookups (no crash, exit 2)', async () => {
    const { result, output } = await captureStderr(() => dispatchDev(['__proto__']));
    assert.notEqual(result, 0);
    assert.match(output, /unknown/i);
  });
});
