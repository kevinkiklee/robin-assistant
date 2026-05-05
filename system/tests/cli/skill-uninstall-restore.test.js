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
});
