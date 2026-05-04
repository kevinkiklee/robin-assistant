// E2E scenario: today.md mtime > 48h triggers Dream Phase 4 housekeeping
// to delete it. The next Dream that picks a question rewrites.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeToday, clearToday, readToday } from '../../../scripts/lib/learning-queue.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'lq-stale-today-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/runtime/state/learning-queue'), { recursive: true });
  return dir;
}

// Dream Phase 4 step 17.9: if today.md mtime > 48h, delete it.
function staleCleanup(workspaceDir, nowMs, thresholdMs = 48 * 3600 * 1000) {
  const path = join(workspaceDir, 'user-data/runtime/state/learning-queue/today.md');
  if (!existsSync(path)) return false;
  const mtimeMs = statSync(path).mtimeMs;
  if (nowMs - mtimeMs > thresholdMs) {
    clearToday(workspaceDir);
    return true;
  }
  return false;
}

describe('e2e: jobs: learning-queue stale today.md cleanup', () => {
  it('today.md older than 48h is deleted by Dream Phase 4', () => {
    const ws = workspace();
    writeToday(
      ws,
      { qid: 'q1', question: 'Q?', why: 'w', domain: 'd', original_tag: 'fact' },
      '2026-05-01T05:30:00Z'
    );
    const path = join(ws, 'user-data/runtime/state/learning-queue/today.md');
    // Age the file: set mtime to 49h ago.
    const nowMs = Date.parse('2026-05-04T12:00:00Z');
    const oldMs = nowMs - 49 * 3600 * 1000;
    utimesSync(path, new Date(oldMs), new Date(oldMs));

    assert.ok(existsSync(path));
    const cleaned = staleCleanup(ws, nowMs);
    assert.equal(cleaned, true);
    assert.equal(existsSync(path), false);
    assert.equal(readToday(ws), null);
  });

  it('today.md within 48h is preserved', () => {
    const ws = workspace();
    writeToday(
      ws,
      { qid: 'q1', question: 'Q?', why: 'w', domain: 'd', original_tag: 'fact' },
      '2026-05-04T05:30:00Z'
    );
    const path = join(ws, 'user-data/runtime/state/learning-queue/today.md');
    const nowMs = Date.parse('2026-05-04T12:00:00Z'); // 6.5h after write
    const cleaned = staleCleanup(ws, nowMs);
    assert.equal(cleaned, false);
    assert.ok(existsSync(path));
  });

  it('cleanup is a no-op when today.md is absent', () => {
    const ws = workspace();
    const cleaned = staleCleanup(ws, Date.parse('2026-05-04T12:00:00Z'));
    assert.equal(cleaned, false);
  });
});
