import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSessionBlock } from '../scripts/lib/handoff.js';

function setup(initialContent) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-'));
  const file = join(dir, 'session-handoff.md');
  writeFileSync(file, initialContent);
  return { dir, file };
}

test('writeSessionBlock: creates new block when file has no matching session', () => {
  const { file } = setup(`---
description: Session Handoff
---

# Session Handoff

<!-- APPEND-ONLY below -->
`);
  const result = writeSessionBlock(file, 'claude-code-20260430-2025', 'ended: 2026-04-30T20:55:00Z (auto)\ninbox additions: 8');
  const out = readFileSync(file, 'utf8');
  assert.equal(result.action, 'created');
  assert.match(out, /## Session — claude-code-20260430-2025\n/);
  assert.match(out, /ended: 2026-04-30T20:55:00Z \(auto\)/);
  assert.match(out, /inbox additions: 8/);
});
