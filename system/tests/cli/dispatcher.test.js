// Smoke-level coverage for the bin/robin.js dispatcher. Exercises only the
// argv-parsing surface: known help paths return exit 0; unknown subcommand
// returns non-zero; -h / --help / "help" all map to the same path.
//
// We import main() rather than spawning a subprocess so failures show
// inline stack traces. The dispatcher is designed for in-process invocation
// per its docstring and the e2e harness.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../bin/robin.js';

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

describe('bin/robin: dispatcher', () => {
  it('prints help and exits 0 with no args', async () => {
    const { result, output } = await captureStdout(() => main([], process.env));
    assert.equal(result.exitCode, 0);
    assert.match(output, /Robin — personal AI assistant CLI/);
    assert.match(output, /usage:/);
  });

  it('prints help and exits 0 with --help', async () => {
    const { result, output } = await captureStdout(() => main(['--help'], process.env));
    assert.equal(result.exitCode, 0);
    assert.match(output, /usage:/);
  });

  it('prints help and exits 0 with -h', async () => {
    const { result, output } = await captureStdout(() => main(['-h'], process.env));
    assert.equal(result.exitCode, 0);
    assert.match(output, /usage:/);
  });

  it('prints help and exits 0 with the literal "help" subcommand', async () => {
    const { result, output } = await captureStdout(() => main(['help'], process.env));
    assert.equal(result.exitCode, 0);
    assert.match(output, /usage:/);
  });

  it('returns non-zero exit code for an unknown subcommand', async () => {
    const { result, output } = await captureStderr(() =>
      main(['this-subcommand-does-not-exist'], process.env)
    );
    assert.notEqual(result.exitCode, 0, 'unknown subcommand should not exit 0');
    assert.match(output, /unknown command|unknown subcommand|usage:/i);
  });

  it('help output advertises all top-level subcommands in the README Commands table', async () => {
    const { output } = await captureStdout(() => main([], process.env));
    // Every documented subcommand should appear at least once in HELP.
    // If a subcommand is added/removed, this test's expected list updates
    // alongside HELP — keeps the dispatcher's surface honest.
    const expected = [
      'init', 'run', 'job ', 'jobs', 'update', 'link',
      'watch', 'recall', 'regenerate-memory-index',
    ];
    for (const cmd of expected) {
      assert.match(output, new RegExp(`\\brobin ${cmd}`), `HELP missing: robin ${cmd}`);
    }
  });
});
