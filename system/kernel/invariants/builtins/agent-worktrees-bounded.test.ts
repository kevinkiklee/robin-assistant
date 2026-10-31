import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentWorktreesBoundedInvariant } from './agent-worktrees-bounded.ts';

/** Create a temp dir acting as the repo root (no .worktrees subdir by default). */
function mkRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), 'robin-wt-'));
}

test('agent.worktrees_bounded: ok when .worktrees/ directory is missing', async () => {
  const repoRoot = mkRepoRoot();
  const inv = agentWorktreesBoundedInvariant(repoRoot);
  const r = await inv.check();
  assert.equal(r.ok, true);
});

test('agent.worktrees_bounded: ok when count is at or below the threshold (3 dirs)', async () => {
  const repoRoot = mkRepoRoot();
  const worktreesDir = join(repoRoot, '.worktrees');
  mkdirSync(worktreesDir);
  for (const name of ['20260101T000001Z', '20260102T000001Z', '20260103T000001Z']) {
    mkdirSync(join(worktreesDir, name));
  }
  const inv = agentWorktreesBoundedInvariant(repoRoot, { warnCount: 5 });
  const r = await inv.check();
  assert.equal(r.ok, true);
});

test('agent.worktrees_bounded: fails with count and oldest dir when above threshold (6 dirs)', async () => {
  const repoRoot = mkRepoRoot();
  const worktreesDir = join(repoRoot, '.worktrees');
  mkdirSync(worktreesDir);
  const dirs = [
    '20260101T000001Z',
    '20260102T000001Z',
    '20260103T000001Z',
    '20260104T000001Z',
    '20260105T000001Z',
    '20260106T000001Z',
  ];
  for (const name of dirs) {
    mkdirSync(join(worktreesDir, name));
  }
  const inv = agentWorktreesBoundedInvariant(repoRoot, { warnCount: 5 });
  const r = await inv.check();
  assert.equal(r.ok, false, 'should fail when count exceeds threshold');
  assert.match(r.message ?? '', /6/, 'message should contain the count');
  assert.match(r.message ?? '', /20260101T000001Z/, 'message should contain the oldest dirname');
  assert.ok(r.remediation, 'remediation should be present');
  assert.match(r.remediation ?? '', /worktree/, 'remediation should mention git worktree');
});

test('agent.worktrees_bounded: non-directory entries in .worktrees/ are not counted', async () => {
  const repoRoot = mkRepoRoot();
  const worktreesDir = join(repoRoot, '.worktrees');
  mkdirSync(worktreesDir);
  // Add 6 files (not directories) + 1 real directory — should count as 1, not 7
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(worktreesDir, `file-${i}.txt`), '');
  }
  mkdirSync(join(worktreesDir, '20260101T000001Z'));
  const inv = agentWorktreesBoundedInvariant(repoRoot, { warnCount: 5 });
  const r = await inv.check();
  assert.equal(r.ok, true, 'files should not count toward the threshold');
});

test('agent.worktrees_bounded: ok when .worktrees/ exists but is a file (fs-error path)', async () => {
  const repoRoot = mkRepoRoot();
  // Write a file at .worktrees to simulate the fs-error path (readdirSync on a file throws)
  writeFileSync(join(repoRoot, '.worktrees'), 'not-a-dir');
  const inv = agentWorktreesBoundedInvariant(repoRoot);
  const r = await inv.check();
  // Should fail-open (ok: true) rather than throwing
  assert.equal(r.ok, true);
});
