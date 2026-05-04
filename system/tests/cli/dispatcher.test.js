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

async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    chunks.push(typeof s === 'string' ? s : s.toString());
    return true;
  };
  try {
    const result = await fn();
    return { result, output: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

async function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => {
    chunks.push(typeof s === 'string' ? s : s.toString());
    return true;
  };
  try {
    const result = await fn();
    return { result, output: chunks.join('') };
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
      'watch', 'recall', 'trust', 'regenerate-memory-index',
    ];
    for (const cmd of expected) {
      assert.match(output, new RegExp(`\\brobin ${cmd}`), `HELP missing: robin ${cmd}`);
    }
  });

  it('robin memory --help dispatches', async () => {
    const { result, output } = await captureStdout(() => main(['memory', '--help'], process.env));
    assert.equal(result.exitCode, 0);
    assert.match(output, /usage: robin memory/);
  });

  it('robin discord --help dispatches', async () => {
    const { result, output } = await captureStdout(() => main(['discord', '--help'], process.env));
    assert.equal(result.exitCode, 0);
    assert.match(output, /usage: robin discord/);
  });

  it('robin dev --help dispatches', async () => {
    const { result, output } = await captureStdout(() => main(['dev', '--help'], process.env));
    assert.equal(result.exitCode, 0);
    assert.match(output, /usage: robin dev/);
  });

  // backup/restore spawn child scripts via `stdio: 'inherit'`. The children
  // can be long-running (backup tars user-data/) or interactive (restore
  // prompts on stdin), so we don't wait for main() to settle. Instead, we
  // race main() against a short timer: dispatch reaches the spawn within ~ms,
  // so any "unknown command:" parent-side error would already be in stderr.
  // After the race we kill any descendant child to unblock the pending main().
  async function dispatchOnly(args) {
    const chunks = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => {
      chunks.push(typeof s === 'string' ? s : s.toString());
      return true;
    };
    let mainPromise;
    try {
      mainPromise = main(args, process.env);
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      process.stderr.write = original;
    }
    // Best-effort: kill any spawned descendants so main() can resolve in
    // background and not leak into other tests.
    try {
      const { execSync } = await import('node:child_process');
      execSync(`pkill -f "system/scripts/cli/${args[0]}.js" 2>/dev/null || true`);
    } catch {
      /* ignore */
    }
    // Don't await mainPromise — child may have been killed; we only need
    // to confirm parent-side dispatch.
    void mainPromise.catch(() => {});
    return chunks.join('');
  }

  it('robin backup dispatches (no "unknown command" error)', async () => {
    // Backup may exit non-zero in a test workspace if its environment isn't fully scaffolded.
    // We assert only that the dispatch path reaches it.
    const output = await dispatchOnly(['backup', '--help']);
    assert.doesNotMatch(output, /unknown command/);
  });

  it('robin restore dispatches (no "unknown command" error)', async () => {
    const output = await dispatchOnly(['restore', '--help']);
    assert.doesNotMatch(output, /unknown command/);
  });

  it('robin memory unknown op exits non-zero (exit code propagated from dispatcher)', async () => {
    const { result } = await captureStderr(() => main(['memory', 'not-a-real-op'], process.env));
    assert.notEqual(result.exitCode, 0,
      'unknown op exit code from dispatchMemory must propagate to main');
  });
});
