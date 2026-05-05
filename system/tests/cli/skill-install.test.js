import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchSkill } from '../../scripts/cli/skill.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/external-skills');

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'robin-skill-install-'));
  mkdirSync(join(ws, 'system', 'jobs'), { recursive: true });
  // bin/robin.js marker — required by resolveCliWorkspaceDir() validation.
  // Pattern from system/tests/cli/watches-cli.test.js.
  mkdirSync(join(ws, 'bin'), { recursive: true });
  writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');
  return ws;
}

describe('robin skill install (local path)', () => {
  it('installs from a local fixture path', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      const exit = await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      assert.equal(exit, 0);
      assert.ok(existsSync(join(ws, 'user-data/skills/external/valid-basic/SKILL.md')));
      assert.ok(existsSync(join(ws, 'user-data/skills/external/INDEX.md')));
      const m = JSON.parse(readFileSync(join(ws, 'user-data/runtime/state/installed-skills.json'), 'utf8'));
      assert.equal(m.skills.length, 1);
      assert.equal(m.skills[0].name, 'valid-basic');
      assert.equal(m.skills[0].trust, 'untrusted-mixed');
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('rejects on name collision with existing system/jobs/<name>.md', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    const jobFile = join(ws, 'system/jobs/valid-basic.md');
    writeFileSync(jobFile, '---\nname: valid-basic\n---\n');
    try {
      const exit = await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      assert.notEqual(exit, 0);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('rejects on missing description', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      const exit = await dispatchSkill(['install', join(FIXTURES, 'invalid-no-description')]);
      assert.notEqual(exit, 0);
      assert.ok(!existsSync(join(ws, 'user-data/skills/external/invalid-no-description')));
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('rejects on duplicate install', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      const e1 = await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      assert.equal(e1, 0);
      const e2 = await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      assert.notEqual(e2, 0);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Regression: the original install flow ran `git rev-parse HEAD` against
  // `finalDest` AFTER copying the staged folder. For local installs there
  // is no .git in the staged folder, so git would walk UP the parent
  // directory chain and resolve to the wrapping repo's HEAD — silently
  // recording the wrong commit hash. Fix landed in 2fc1fae: capture commit
  // from staging BEFORE the move, and never run rev-parse against finalDest.
  // This test guards against regression by placing the workspace inside a
  // git repo and asserting the recorded commit is empty for a local install
  // (NOT the wrapping repo's HEAD).
  it('local install records empty commit, never walks up to wrapping repo HEAD', async () => {
    // Create a wrapping git repo, then put the workspace inside it.
    const wrapper = mkdtempSync(join(tmpdir(), 'robin-skill-wrap-'));
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: wrapper, stdio: 'ignore' });
    spawnSync('git', ['-C', wrapper, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    spawnSync('git', ['-C', wrapper, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    spawnSync('git', ['-C', wrapper, 'config', 'commit.gpgsign', 'false'], { stdio: 'ignore' });
    writeFileSync(join(wrapper, 'README.md'), '# wrapper\n');
    spawnSync('git', ['-C', wrapper, 'add', '.'], { stdio: 'ignore' });
    spawnSync('git', ['-C', wrapper, 'commit', '-m', 'initial'], { stdio: 'ignore' });
    const wrapperHead = spawnSync('git', ['-C', wrapper, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(wrapperHead.length === 40, 'wrapping repo HEAD should be 40-char SHA');

    // Workspace lives INSIDE the wrapping repo.
    const ws = join(wrapper, 'workspace');
    mkdirSync(join(ws, 'system', 'jobs'), { recursive: true });
    mkdirSync(join(ws, 'bin'), { recursive: true });
    writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');

    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      const exit = await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      assert.equal(exit, 0);
      const m = JSON.parse(readFileSync(join(ws, 'user-data/runtime/state/installed-skills.json'), 'utf8'));
      assert.equal(m.skills.length, 1);
      // The bug: commit would be set to wrapperHead because git rev-parse
      // HEAD walked up from finalDest to the wrapping repo. Fixed: empty
      // string for local installs.
      assert.equal(m.skills[0].commit, '', `expected empty commit for local install, got "${m.skills[0].commit}" (wrapper HEAD: ${wrapperHead})`);
      assert.notEqual(m.skills[0].commit, wrapperHead, 'commit must not be wrapping repo HEAD (rev-parse walked up parent dirs)');
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(wrapper, { recursive: true, force: true });
    }
  });
});
