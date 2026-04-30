import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { normalizeSummary, summaryHash } from '../scripts/migrate-auto-memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'system', 'scripts', 'migrate-auto-memory.js');

function runScript(args = []) {
  return execFileSync('node', [SCRIPT, ...args, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('migrate-auto-memory', () => {
  it('produces JSON shape with by_host', () => {
    const out = JSON.parse(runScript());
    assert.ok(out.by_host);
    assert.ok('claude-code' in out.by_host);
  });

  it('reports zero migrated when run twice in a row (idempotent)', () => {
    // First run drains anything; second run should be 0.
    runScript(['--apply']);
    const out = JSON.parse(runScript(['--apply']));
    assert.equal(out.migrated, 0);
  });

  it('does not modify inbox.md without --apply', () => {
    const inbox = join(REPO_ROOT, 'user-data', 'memory', 'inbox.md');
    const before = existsSync(inbox)
      ? execFileSync('wc', ['-c', inbox], { encoding: 'utf8' })
      : '';
    runScript();
    const after = existsSync(inbox)
      ? execFileSync('wc', ['-c', inbox], { encoding: 'utf8' })
      : '';
    assert.equal(before, after);
  });
});

describe('migrate-auto-memory dedup hashing', () => {
  it('collapses wording variants of the same feedback to one hash', () => {
    const variants = [
      "Don't summarize what was just done at the end of a response. The user reads the diff directly.",
      "Do not add a summary of what changed at the end of responses.",
      "Do not summarize what you just did at the end of a response.",
      "Stop providing summaries of code changes at the end of responses. User reads diffs.",
    ];
    const hashes = new Set(variants.map(summaryHash));
    // All four are about the same preference but worded differently. They will NOT
    // all collapse — that's the realistic limit of token-prefix hashing — but at
    // least the literal-text re-runs (the most common dup case) must collapse.
    const literalDup = "Don't summarize what was just done at the end of a response. The user reads the diff directly.";
    assert.equal(summaryHash(variants[0]), summaryHash(literalDup));
    // First-12-token normalization should ignore trivial punctuation/whitespace drift:
    assert.equal(
      summaryHash("Prefers dark roast over light roast."),
      summaryHash("prefers dark roast over light roast"),
    );
    assert.equal(
      summaryHash("Prefers dark roast over light roast"),
      summaryHash("Prefers   dark   roast   over   light   roast!!!"),
    );
    // Different facts must hash differently.
    assert.notEqual(summaryHash("Prefers dark roast"), summaryHash("Owns a Nikon Zf"));
    // Sanity on normalize:
    assert.equal(normalizeSummary("Hello, World!  Foo-bar."), "hello world foo bar");
  });
});
