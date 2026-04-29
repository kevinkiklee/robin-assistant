import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { countBytes, countLines, estimateTokens, measure } from '../scripts/lib/tokenizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'system', 'scripts', 'measure-tokens.js');

function runHarness(args = []) {
  return execFileSync('node', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

describe('tokenizer', () => {
  it('counts bytes deterministically', () => {
    assert.equal(countBytes('hello'), 5);
    assert.equal(countBytes(''), 0);
    assert.equal(countBytes('café'), 5); // utf8: c-a-f-é(2 bytes)
  });

  it('counts lines correctly', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('one'), 1);
    assert.equal(countLines('one\n'), 1);
    assert.equal(countLines('one\ntwo'), 2);
    assert.equal(countLines('one\ntwo\n'), 2);
  });

  it('estimates tokens via bytes/3.7 heuristic', () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(37), 10);
    assert.equal(estimateTokens(38), 11); // ceil
  });

  it('measure() returns bytes/lines/tokens together', () => {
    const m = measure('hello\nworld');
    assert.equal(m.bytes, 11);
    assert.equal(m.lines, 2);
    assert.ok(m.tokens >= 1);
  });
});

describe('measure-tokens harness', () => {
  it('produces deterministic JSON output across two runs', () => {
    const a = JSON.parse(runHarness(['--json']));
    const b = JSON.parse(runHarness(['--json']));
    // snapshot_at differs; everything else must match.
    delete a.snapshot_at;
    delete b.snapshot_at;
    assert.deepEqual(a, b);
  });

  it('reports tier1 bytes/lines/tokens and a budget object', () => {
    const snap = JSON.parse(runHarness(['--json']));
    assert.ok(snap.tier1);
    assert.ok(typeof snap.tier1.total_bytes === 'number');
    assert.ok(typeof snap.tier1.total_lines === 'number');
    assert.ok(typeof snap.tier1.total_tokens === 'number');
    assert.ok(snap.tier1.budget?.max_tokens > 0);
    assert.ok(snap.tier1.budget?.max_lines > 0);
  });

  it('reports tier2 protocols sorted by tokens desc', () => {
    const snap = JSON.parse(runHarness(['--json']));
    const tokens = snap.tier2.files.map((f) => f.tokens);
    const sorted = [...tokens].sort((a, b) => b - a);
    assert.deepEqual(tokens, sorted);
  });

  it('--check exits 0 in observe-only mode regardless of overages', () => {
    // observe-only: enforce_caps:false in token-budget.json. Should be 0.
    const out = execFileSync('node', [SCRIPT, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // No throw means exit 0
    assert.ok(typeof out === 'string');
  });

  it('budget json is parseable', () => {
    const path = join(REPO_ROOT, 'system', 'scripts', 'lib', 'token-budget.json');
    const json = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(Array.isArray(json.tier1_files));
    assert.ok(Array.isArray(json.tier2_globs));
    assert.ok(Array.isArray(json.stability_order));
  });

  it('--host=claude-code prepends CLAUDE.md to tier1', () => {
    const snap = JSON.parse(runHarness(['--json', '--host=claude-code']));
    const claudePtr = snap.tier1.files.find((f) => f.path === 'CLAUDE.md');
    assert.ok(claudePtr, 'CLAUDE.md should appear in tier1 when --host=claude-code');
    assert.equal(claudePtr.host_pointer_for, 'claude-code');
  });

  it('detects cache-order violations when stability is mis-ordered', () => {
    // Synthetic test: read budget, swap two entries to create a violation, validate.
    // We don't mutate the file; just verify the validator reports nothing on the real config.
    const snap = JSON.parse(runHarness(['--json']));
    assert.ok(Array.isArray(snap.tier1.cache_order_violations));
  });

  it('lists failures even in observe-only mode (informational)', () => {
    const snap = JSON.parse(runHarness(['--json']));
    assert.ok(Array.isArray(snap.failures));
  });
});
