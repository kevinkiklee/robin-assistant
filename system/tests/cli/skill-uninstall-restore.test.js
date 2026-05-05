import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchSkill } from '../../scripts/cli/skill.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/external-skills');

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'robin-skill-uninstall-'));
  mkdirSync(join(ws, 'system', 'jobs'), { recursive: true });
  // bin/robin.js marker — required by resolveCliWorkspaceDir() validation.
  mkdirSync(join(ws, 'bin'), { recursive: true });
  writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');
  return ws;
}

describe('robin skill uninstall', () => {
  it('removes folder and manifest entry, regenerates INDEX', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      assert.ok(existsSync(join(ws, 'user-data/skills/external/valid-basic')));
      const exit = await dispatchSkill(['uninstall', 'valid-basic']);
      assert.equal(exit, 0);
      assert.ok(!existsSync(join(ws, 'user-data/skills/external/valid-basic')));
      const m = JSON.parse(readFileSync(join(ws, 'user-data/runtime/state/installed-skills.json'), 'utf8'));
      assert.equal(m.skills.length, 0);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns non-zero when skill not found', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      const exit = await dispatchSkill(['uninstall', 'does-not-exist']);
      assert.notEqual(exit, 0);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('robin skill restore', () => {
  it('reinstalls from manifest after deletion of external/', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      // Install once with file:// path so restore can re-run it.
      await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      assert.ok(existsSync(join(ws, 'user-data/skills/external/valid-basic')));
      // Simulate fresh checkout: nuke external/ but keep manifest.
      rmSync(join(ws, 'user-data/skills/external'), { recursive: true, force: true });
      assert.ok(!existsSync(join(ws, 'user-data/skills/external/valid-basic')));
      // Restore.
      const exit = await dispatchSkill(['restore']);
      assert.equal(exit, 0);
      assert.ok(existsSync(join(ws, 'user-data/skills/external/valid-basic')));
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('preserves installedAt timestamp on restore (does not drift forward)', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      const manifestPath = join(ws, 'user-data/runtime/state/installed-skills.json');
      const beforeManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const installedAtBefore = beforeManifest.skills[0].installedAt;
      assert.ok(installedAtBefore, 'installedAt should be set after install');

      // Backdate the manifest to simulate an older install. We want to prove
      // restore preserves the recorded date, not bumps it to "now".
      const backdated = '2025-01-15T00:00:00.000Z';
      beforeManifest.skills[0].installedAt = backdated;
      writeFileSync(manifestPath, JSON.stringify(beforeManifest, null, 2) + '\n');

      // Wipe folder and restore.
      rmSync(join(ws, 'user-data/skills/external'), { recursive: true, force: true });
      const exit = await dispatchSkill(['restore']);
      assert.equal(exit, 0);

      const afterManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      assert.equal(
        afterManifest.skills[0].installedAt,
        backdated,
        'restore must preserve installedAt — the original install date is what users care about, not "when did I last restore"'
      );
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('preserves recorded commit on restore (does not silently follow upstream HEAD)', async () => {
    // For local sources, restore goes through the same path but commit
    // stays empty. For git sources we'd need network. This test exercises
    // the local branch and asserts commit doesn't get rewritten to
    // something unexpected (which would happen if rev-parse walked up).
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      const manifestPath = join(ws, 'user-data/runtime/state/installed-skills.json');
      const before = JSON.parse(readFileSync(manifestPath, 'utf8'));
      assert.equal(before.skills[0].commit, '', 'local install records empty commit');

      rmSync(join(ws, 'user-data/skills/external'), { recursive: true, force: true });
      const exit = await dispatchSkill(['restore']);
      assert.equal(exit, 0);

      const after = JSON.parse(readFileSync(manifestPath, 'utf8'));
      assert.equal(after.skills[0].commit, '', 'restore must not rewrite empty commit to a stray value');
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('robin skill update', () => {
  it('skips file:// source skills (no upstream to pull)', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      // Install from a local file path → manifest source is file://...
      await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      // Update should succeed (exit 0) with skip message — no failures.
      const exit = await dispatchSkill(['update']);
      assert.equal(exit, 0);
      // Manifest should be unchanged.
      const m = JSON.parse(readFileSync(join(ws, 'user-data/runtime/state/installed-skills.json'), 'utf8'));
      assert.equal(m.skills.length, 1);
      assert.ok(m.skills[0].source.startsWith('file://'));
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns non-zero when named skill is not installed', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      const exit = await dispatchSkill(['update', 'does-not-exist']);
      assert.notEqual(exit, 0);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
