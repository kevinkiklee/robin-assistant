import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { distCurrentInvariant } from './dist-current.ts';

function tmpRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), 'robin-dist-current-'));
}

function writeStamp(
  repoRoot: string,
  sha: string,
  at = new Date().toISOString(),
  deepHash?: string,
): void {
  mkdirSync(join(repoRoot, 'dist'), { recursive: true });
  const lines = deepHash !== undefined ? [sha, at, deepHash] : [sha, at];
  writeFileSync(join(repoRoot, 'dist', '.build-stamp'), `${lines.join('\n')}\n`);
}

test('dist-current: no stamp on disk → ok (dev mode, never built)', async () => {
  const repoRoot = tmpRepoRoot();
  const inv = distCurrentInvariant({ repoRoot, loadedSha: () => 'aaa' });
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('dist-current: stamp present but loadedSha() is null → ok (tsx dev)', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'aaa');
  const inv = distCurrentInvariant({ repoRoot, loadedSha: () => null });
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('dist-current: matching SHAs → ok', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'aaa');
  const inv = distCurrentInvariant({ repoRoot, loadedSha: () => 'aaa' });
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('dist-current: mismatched SHAs → fails, message names both SHAs', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'aaa');
  const inv = distCurrentInvariant({ repoRoot, loadedSha: () => 'bbb' });
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /aaa/);
  assert.match(r.message ?? '', /bbb/);
  assert.ok(r.remediation, 'remediation should be present');
});

test('dist-current: no repair() — staleness is fixed by restart, not self-repair', () => {
  const repoRoot = tmpRepoRoot();
  const inv = distCurrentInvariant({ repoRoot, loadedSha: () => null });
  assert.equal(inv.repair, undefined);
});

test('dist-current: metadata sanity (name, severity)', () => {
  const repoRoot = tmpRepoRoot();
  const inv = distCurrentInvariant({ repoRoot, loadedSha: () => null });
  assert.equal(inv.name, 'mcp.dist_current');
  assert.equal(inv.severity, 'warning');
});

test('dist-current: same sha but moved deep hash (dirty-tree rebuild) → fails', async () => {
  // `pnpm build` stamps `git rev-parse --short HEAD`, which does not move for
  // uncommitted work. Comparing shas alone reported "current" for the most
  // common rebuild in this repo, so a daemon serving code from before that
  // rebuild looked healthy in the daily doctor.
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'aaa', undefined, 'deep-new');
  const inv = distCurrentInvariant({
    repoRoot,
    loadedSha: () => 'aaa',
    loadedDeepHash: () => 'deep-old',
  });
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /rebuilt|uncommitted/i, 'should explain the unchanged sha');
  assert.ok(r.remediation, 'remediation should be present');
});

test('dist-current: matching sha and deep hash → ok', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'aaa', undefined, 'deep-same');
  const inv = distCurrentInvariant({
    repoRoot,
    loadedSha: () => 'aaa',
    loadedDeepHash: () => 'deep-same',
  });
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('dist-current: absent deep hash on either side falls back to the sha', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'aaa'); // legacy 2-line stamp
  const inv = distCurrentInvariant({
    repoRoot,
    loadedSha: () => 'aaa',
    loadedDeepHash: () => 'deep-old',
  });
  const r = await inv.check();
  assert.equal(r.ok, true, 'nothing to compare → not stale');
});
