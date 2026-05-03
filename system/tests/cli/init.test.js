// Smoke coverage for `robin init`. Exercises the package-root resolution
// and the bootstrap-into-target path. Uses the REAL package scaffold (this
// repo) — the test catches packageRoot resolution bugs that wouldn't show
// up in pure-unit setup() tests with synthetic scaffolds.
//
// We do NOT test the "refuse to bootstrap into the package itself" path
// inline because it calls process.exit(2), which would kill the test
// process. That path warrants a subprocess-spawn test if it ever
// regresses.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdInit } from '../../scripts/cli/init.js';

function silenceLog(fn) {
  const origLog = console.log;
  const origStdout = process.stdout.write.bind(process.stdout);
  console.log = () => {};
  process.stdout.write = () => true;
  return Promise.resolve(fn()).finally(() => {
    console.log = origLog;
    process.stdout.write = origStdout;
  });
}

describe('cli/init: cmdInit', () => {
  let target;

  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), 'robin-init-'));
  });

  afterEach(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it('prints help text on --help and does not bootstrap', async () => {
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => {
      chunks.push(typeof s === 'string' ? s : s.toString());
      return true;
    };
    try {
      await cmdInit(['--help']);
    } finally {
      process.stdout.write = orig;
    }
    const out = chunks.join('');
    assert.match(out, /robin init — bootstrap a fresh workspace/);
    assert.match(out, /--target/);
    assert.match(out, /--no-prompt/);
    // Help path must not have created user-data in cwd.
    assert.equal(existsSync(join(target, 'user-data')), false);
  });

  it('bootstraps a fresh workspace into --target with --ci', async () => {
    await silenceLog(() => cmdInit(['--target', target, '--ci']));
    assert.ok(existsSync(join(target, 'user-data')), 'user-data dir created');
    assert.ok(
      existsSync(join(target, 'user-data/memory/INDEX.md')),
      'memory/INDEX.md scaffolded'
    );
    assert.ok(
      existsSync(join(target, 'user-data/runtime/config/robin.config.json')),
      'robin.config.json scaffolded'
    );
    assert.ok(
      existsSync(join(target, 'user-data/artifacts/input')),
      'artifacts/input scaffolded'
    );
  });

  it('writes flag-provided identity into config when --ci + --name + --tz', async () => {
    await silenceLog(() =>
      cmdInit([
        '--target', target,
        '--ci',
        '--name', 'Test User',
        '--tz', 'America/New_York',
        '--email', 'test@example.com',
      ])
    );
    const cfgPath = join(target, 'user-data/runtime/config/robin.config.json');
    assert.ok(existsSync(cfgPath), 'config written');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(cfg.user.name, 'Test User');
    assert.equal(cfg.user.timezone, 'America/New_York');
    assert.equal(cfg.user.email, 'test@example.com');
  });

  it('accepts --no-prompt as alias for --ci', async () => {
    await silenceLog(() => cmdInit(['--target', target, '--no-prompt']));
    assert.ok(existsSync(join(target, 'user-data/memory/INDEX.md')));
  });
});
