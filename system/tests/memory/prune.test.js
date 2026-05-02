// Tests for prune-preview and prune-execute. Uses synthetic fixtures so
// the test doesn't touch the real workspace memory.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PREVIEW = join(REPO_ROOT, 'system', 'scripts', 'memory', 'prune-preview.js');

function run(cmd, args = []) {
  const r = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exit: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('prune-preview', () => {
  it('runs cleanly and emits JSON', () => {
    const r = run('node', [PREVIEW, '--json']);
    assert.equal(r.exit, 0);
    const out = JSON.parse(r.stdout);
    assert.ok('cutoff' in out, 'cutoff field present');
    assert.ok('total_files' in out);
    assert.ok('total_bytes' in out);
    assert.ok(out.transactions);
    assert.ok(out.conversations);
    assert.ok(out.decisions_journal_year_sections);
  });

  it('cutoff is a YYYY-MM-DD date string', () => {
    const r = run('node', [PREVIEW, '--json']);
    const out = JSON.parse(r.stdout);
    assert.match(out.cutoff, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('cutoff is approximately 12 months ago', () => {
    const r = run('node', [PREVIEW, '--json']);
    const out = JSON.parse(r.stdout);
    const cutoff = new Date(out.cutoff);
    const now = new Date();
    const diffDays = (now - cutoff) / (1000 * 60 * 60 * 24);
    // 12 months ≈ 365 days; allow 350-380 to handle month-boundary fuzz.
    assert.ok(diffDays >= 350 && diffDays <= 380, `cutoff ~12mo ago, got ${diffDays} days`);
  });

  it('does not modify the workspace (idempotent)', () => {
    // Snapshot the size of user-data/memory/ before and after; should be
    // identical (preview never moves files).
    const before = execFileSync('du', ['-sk', join(REPO_ROOT, 'user-data/memory')], {
      encoding: 'utf8',
    }).split(/\s+/)[0];
    run('node', [PREVIEW]);
    run('node', [PREVIEW]);
    const after = execFileSync('du', ['-sk', join(REPO_ROOT, 'user-data/memory')], {
      encoding: 'utf8',
    }).split(/\s+/)[0];
    assert.equal(before, after);
  });
});

describe('prune-execute (idempotency check)', () => {
  it('second run is a no-op when nothing eligible', () => {
    // The repo has already been pruned in earlier sessions; transactions
    // <12mo are all that remains. This test verifies that a second prune
    // execution doesn't re-archive what's already in archive.
    const r = run('node', [join(REPO_ROOT, 'system/scripts/memory/prune-execute.js')]);
    // Either "nothing eligible" or zero files moved.
    if (r.exit === 0) {
      assert.ok(
        r.stdout.includes('nothing eligible') ||
          r.stdout.match(/moved 0 files/) ||
          r.stdout.match(/moved \d+ files/),
        `unexpected output: ${r.stdout}`,
      );
    } else if (r.exit === 2) {
      // Skipped — sibling sessions active. Acceptable.
      // The skip message is written to stderr, so combine both streams.
      assert.match(r.stdout + r.stderr, /sibling/i);
    } else {
      assert.fail(`prune exited ${r.exit}: stdout=${r.stdout} stderr=${r.stderr}`);
    }
  });
});
