// End-to-end pipeline tests. These exercise the full chain that runs in
// production: migrate → measure-tokens → lint-memory → golden-session →
// regenerate-memory-index --check → existing test suite.
//
// Each test runs a CLI invocation. Failures here mean a real user would
// see a broken workspace, not just a unit-level bug.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function run(cmd, args = []) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exit: 0, stdout: out, stderr: '' };
  } catch (e) {
    return {
      exit: e.status ?? 1,
      stdout: e.stdout?.toString?.() ?? '',
      stderr: e.stderr?.toString?.() ?? '',
    };
  }
}

describe('e2e: full toolchain', () => {
  it('measure-tokens --check passes', () => {
    const r = run('node', ['system/scripts/diagnostics/measure-tokens.js', '--check']);
    assert.equal(r.exit, 0, `measure-tokens failed: ${r.stderr}`);
  });

  it('lint-memory passes', () => {
    const r = run('node', ['system/scripts/memory/lint.js']);
    assert.equal(r.exit, 0, `lint-memory failed: ${r.stdout}`);
  });

  it('golden-session --check matches', () => {
    const r = run('node', ['system/scripts/diagnostics/golden-session.js', '--check']);
    assert.equal(r.exit, 0, `golden-session drift: ${r.stderr}`);
  });

  it('memory INDEX is up to date', () => {
    const r = run('node', ['system/scripts/memory/regenerate-index.js', '--check']);
    assert.equal(r.exit, 0, `INDEX out of date: ${r.stderr}`);
  });

  it('migrate.js dry-run succeeds', () => {
    const r = run('node', ['system/scripts/migrate/apply.js', '--dry-run']);
    assert.equal(r.exit, 0, `migrate dry-run failed: ${r.stderr}`);
  });

  it('prune-preview runs cleanly', () => {
    const r = run('node', ['system/scripts/memory/prune-preview.js', '--json']);
    assert.equal(r.exit, 0, `prune-preview failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok('total_files' in out);
    assert.ok('total_bytes' in out);
  });

  it('migrate-auto-memory dry-run succeeds', () => {
    const r = run('node', ['system/scripts/capture/auto-memory.js', '--json']);
    assert.equal(r.exit, 0);
    const out = JSON.parse(r.stdout);
    assert.ok('by_host' in out);
  });

  it('robin update succeeds (no pending changes)', () => {
    const r = run('node', ['bin/robin.js', 'update']);
    assert.equal(r.exit, 0, `robin update failed: ${r.stderr}`);
  });

  it('all required Tier 1 files exist on disk', () => {
    const budget = JSON.parse(
      run('cat', ['system/scripts/diagnostics/lib/token-budget.json']).stdout,
    );
    for (const entry of budget.tier1_files) {
      if (entry.required) {
        const r = run('test', ['-f', join(REPO_ROOT, entry.path)]);
        assert.equal(r.exit, 0, `Required Tier 1 file missing: ${entry.path}`);
      }
    }
  });
});
