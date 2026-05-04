// Smoke-level coverage for the `robin discord <op>` dispatcher.
// Exercises the help/unknown-op surface only; the underlying scripts live
// under user-data/runtime/scripts/ (scaffolded from system/scaffold/) and
// are spawned at runtime — they have their own coverage.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchDiscord } from '../../scripts/cli/discord.js';

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

describe('robin discord: dispatcher', () => {
  it('prints help with no args', async () => {
    const { result, output } = await captureStdout(() => dispatchDiscord([]));
    assert.equal(result, 0);
    assert.match(output, /usage: robin discord/);
    for (const op of ['install', 'uninstall', 'auth', 'status', 'health']) {
      assert.match(output, new RegExp(`\\b${op}\\b`), `help missing op: ${op}`);
    }
  });

  it('prints help with --help', async () => {
    const { result, output } = await captureStdout(() => dispatchDiscord(['--help']));
    assert.equal(result, 0);
    assert.match(output, /usage: robin discord/);
  });

  it('prints help with -h', async () => {
    const { result, output } = await captureStdout(() => dispatchDiscord(['-h']));
    assert.equal(result, 0);
    assert.match(output, /usage: robin discord/);
  });

  it('prints help with the literal "help" subcommand', async () => {
    const { result, output } = await captureStdout(() => dispatchDiscord(['help']));
    assert.equal(result, 0);
    assert.match(output, /usage: robin discord/);
  });

  it('returns non-zero for unknown op', async () => {
    const { result, output } = await captureStderr(() => dispatchDiscord(['not-real']));
    assert.notEqual(result, 0);
    assert.match(output, /unknown/i);
  });
});
