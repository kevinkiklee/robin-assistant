import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createWorktree,
  pendingReviewWorktrees,
  pruneWorktree,
  worktreeHasChanges,
} from './worktree.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'robin-wt-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.worktrees/\n');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  mkdirSync(join(repo, 'node_modules'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

test('createWorktree links node_modules without it reading as a change', () => {
  const repo = mkRepo();
  try {
    const { worktree, branch } = createWorktree(repo);
    assert.ok(lstatSync(join(worktree, 'node_modules')).isSymbolicLink());
    assert.equal(worktreeHasChanges(worktree), false);
    pruneWorktree(repo, worktree, branch);
    assert.equal(existsSync(worktree), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('worktreeHasChanges: uncommitted edits count', () => {
  const repo = mkRepo();
  try {
    const { worktree } = createWorktree(repo);
    writeFileSync(join(worktree, 'a.txt'), 'b\n');
    assert.equal(worktreeHasChanges(worktree), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('worktreeHasChanges: a committed fix with a clean status still counts', () => {
  const repo = mkRepo();
  try {
    const { worktree } = createWorktree(repo);
    writeFileSync(join(worktree, 'a.txt'), 'b\n');
    git(worktree, 'commit', '-q', '-am', 'fix');
    assert.equal(git(worktree, 'status', '--porcelain').trim(), '');
    assert.equal(worktreeHasChanges(worktree), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('pendingReviewWorktrees: lists only agent worktrees with changes, with their files', () => {
  const repo = mkRepo();
  try {
    const at = (iso: string) => () => new Date(iso);
    const clean = createWorktree(repo, at('2026-10-01T00:00:00.000Z'));
    const dirty = createWorktree(repo, at('2026-10-02T00:00:00.000Z'));
    const committed = createWorktree(repo, at('2026-10-03T00:00:00.000Z'));
    writeFileSync(join(dirty.worktree, 'a.txt'), 'b\n');
    writeFileSync(join(dirty.worktree, 'new.txt'), 'n\n');
    writeFileSync(join(committed.worktree, 'c.txt'), 'c\n');
    git(committed.worktree, 'add', 'c.txt');
    git(committed.worktree, 'commit', '-q', '-m', 'fix');
    // A non-agent worktree with changes is someone else's work — not counted.
    const other = join(repo, '.worktrees', 'manual');
    git(repo, 'worktree', 'add', '-q', other, '-b', 'feature/x', 'main');
    writeFileSync(join(other, 'a.txt'), 'x\n');

    const pending = pendingReviewWorktrees(repo);
    assert.deepEqual(
      pending.map((p) => [p.branch, p.files]),
      [
        [dirty.branch, ['a.txt', 'new.txt']],
        [committed.branch, ['c.txt']],
      ],
    );
    assert.ok(!pending.some((p) => p.branch === clean.branch), 'a clean worktree is not pending');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
