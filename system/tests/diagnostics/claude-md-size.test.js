import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// Mandatory size guard for the canonical instruction file. Tier-1 token budget
// is the primary CI gate; this test fails fast on local edits before CI runs.
// Cap matches token-budget.json tier1_files entry for CLAUDE.md (max_lines: 120).

test('CLAUDE.md stays within tier-1 line cap', () => {
  const path = join(REPO_ROOT, 'CLAUDE.md');
  const lines = readFileSync(path, 'utf-8').split('\n').length;
  assert.ok(lines <= 120, `CLAUDE.md is ${lines} lines; cap is 120`);
});

test('CLAUDE.md has the Hard Rules section the manifest hashes', () => {
  const path = join(REPO_ROOT, 'CLAUDE.md');
  const content = readFileSync(path, 'utf-8');
  assert.match(content, /^##\s+Hard Rules\b/m);
});
