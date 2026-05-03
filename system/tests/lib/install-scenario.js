// system/tests/lib/install-scenario.js
//
// Heavyweight install scenario — npm pack + npm install into a tempdir,
// then assert the resulting filesystem state matches expected/tree/.
// Separate from the regular runScenario because it doesn't invoke
// bin/robin.js or runHook; it tests the npm install + postinstall flow.
//
// captureSubpath controls which subtree under node_modules/robin-assistant
// is snapshotted. We default to 'user-data/memory' — the scaffold copy from
// postinstall — because it is the most meaningful deterministic surface.
//
// mustExist is an optional list of paths relative to the tempdir that must
// exist after the install. This lets callers add a smoke-test layer on top
// of (or instead of) the full tree snapshot.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { makeTempdir, cleanupTempdir } from './fixtures.js';
import { captureTree, compareTrees, writeTreeAtomic, loadExpectedTree, formatDiff } from './snapshot.js';
import { normalize } from './normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export async function runInstallScenario({
  fixture,
  clock = '2026-05-02T12:00:00Z',
  // Subtree inside node_modules/robin-assistant to snapshot (relative to the
  // install tempdir). 'user-data/memory' is the deterministic scaffold copy.
  captureSubpath = 'node_modules/robin-assistant/user-data/memory',
  extraNormalizers = [],
  ignoreGlobs = [],
  // Extra paths (relative to tempdir) that must exist after install.
  mustExist = [],
}) {
  const fixtureDir = join(REPO_ROOT, 'system/tests/fixtures', fixture);
  if (!existsSync(fixtureDir)) {
    throw new Error(`fixture not found: ${fixtureDir}`);
  }

  const tempdir = makeTempdir();
  let success = false;
  let tarballPath = null;

  try {
    // 1. npm pack the package.
    const pack = spawnSync('npm', ['pack', '--silent'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (pack.status !== 0) {
      throw new Error(`npm pack failed (exit ${pack.status}):\n${pack.stderr || pack.stdout}`);
    }
    const tarballName = (pack.stdout.trim().split('\n').filter(Boolean).pop() ?? '').trim();
    tarballPath = join(REPO_ROOT, tarballName);
    if (!tarballName || !existsSync(tarballPath)) {
      throw new Error(`expected tarball at ${tarballPath} but not found`);
    }

    // 2. Initialize the tempdir and install the tarball.
    const initResult = spawnSync('npm', ['init', '-y', '--silent'], { cwd: tempdir, encoding: 'utf8' });
    if (initResult.status !== 0) {
      throw new Error(`npm init failed (exit ${initResult.status}):\n${initResult.stderr}`);
    }

    const install = spawnSync('npm', ['install', tarballPath, '--silent'], {
      cwd: tempdir,
      env: {
        ...process.env,
        ROBIN_CLOCK: clock,
        // Ensure non-interactive mode in all CI/non-TTY paths.
        CI: '1',
      },
      encoding: 'utf8',
    });
    if (install.status !== 0) {
      throw new Error(`npm install failed (exit ${install.status}):\n${install.stderr || install.stdout}`);
    }

    // 3. mustExist checks — run before tree snapshot so failures are obvious.
    const failedMustExist = [];
    for (const rel of mustExist) {
      const full = join(tempdir, rel);
      if (!existsSync(full)) {
        failedMustExist.push(rel);
      }
    }
    if (failedMustExist.length) {
      throw new Error([
        ``,
        `scenario: ${fixture}`,
        `tempdir (preserved): ${tempdir}`,
        `  Must-exist paths missing after npm install:`,
        ...failedMustExist.map((p) => `    [missing] ${p}`),
        ``,
      ].join('\n'));
    }

    // 4. Capture the relevant subtree under the tempdir.
    //    captureSubpath is relative to the tempdir.
    const captureRoot = join(tempdir, captureSubpath);
    const ctx = { workspace: tempdir, clockMs: Date.parse(clock), extra: extraNormalizers };
    const actualTreeRaw = captureTree(captureRoot, ignoreGlobs);
    // Prefix keys with captureSubpath so the fixture tree is self-documenting.
    const actualTree = {};
    for (const [k, v] of Object.entries(actualTreeRaw)) {
      actualTree[`${captureSubpath}/${k}`] = normalize(v, ctx);
    }

    const expectedTreeDir = join(fixtureDir, 'expected/tree');
    if (process.env.UPDATE_SNAPSHOTS === '1') {
      writeTreeAtomic(expectedTreeDir, actualTree);
    } else {
      const expected = loadExpectedTree(expectedTreeDir);
      const diff = compareTrees(actualTree, expected);
      if (diff.missing.length || diff.unexpected.length || diff.contentDiffs.length) {
        throw new Error([
          ``,
          `scenario: ${fixture}`,
          `tempdir (preserved): ${tempdir}`,
          formatDiff(diff),
          ``,
        ].join('\n'));
      }
    }

    success = true;
  } finally {
    if (tarballPath && existsSync(tarballPath)) {
      try { unlinkSync(tarballPath); } catch { /* ignore */ }
    }
    cleanupTempdir(tempdir, success);
  }
}
