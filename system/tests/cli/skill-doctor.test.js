import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchSkill } from '../../scripts/cli/skill.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/external-skills');

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'robin-skill-doctor-'));
  mkdirSync(join(ws, 'system', 'jobs'), { recursive: true });
  // bin/robin.js marker — required by resolveCliWorkspaceDir() validation.
  mkdirSync(join(ws, 'bin'), { recursive: true });
  writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');
  return ws;
}

describe('robin skill doctor', () => {
  it('regenerates INDEX.md when filesystem state has drifted', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      // Manually write a stale INDEX.md.
      writeFileSync(join(ws, 'user-data/skills/external/INDEX.md'), '# stale\n');
      const exit = await dispatchSkill(['doctor']);
      assert.equal(exit, 0);
      const idx = readFileSync(join(ws, 'user-data/skills/external/INDEX.md'), 'utf8');
      assert.match(idx, /valid-basic/);
      assert.doesNotMatch(idx, /^# stale/);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('reports orphan manifest entry and exits non-zero without --fix', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      // Delete the folder but leave the manifest entry.
      rmSync(join(ws, 'user-data/skills/external/valid-basic'), { recursive: true, force: true });
      const exit = await dispatchSkill(['doctor']);
      assert.notEqual(exit, 0);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('--fix removes orphan manifest entry', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      await dispatchSkill(['install', join(FIXTURES, 'valid-basic')]);
      rmSync(join(ws, 'user-data/skills/external/valid-basic'), { recursive: true, force: true });
      const exit = await dispatchSkill(['doctor', '--fix']);
      assert.equal(exit, 0);
      const m = JSON.parse(readFileSync(join(ws, 'user-data/runtime/state/installed-skills.json'), 'utf8'));
      assert.equal(m.skills.length, 0);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('--fix returns non-zero when non-orphan findings remain', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      // Create an unmanaged folder (valid skill, not in manifest).
      cpSync(join(FIXTURES, 'valid-basic'), join(ws, 'user-data/skills/external/valid-basic'), { recursive: true });
      // No manifest entry exists, so it's "unmanaged".
      const exit = await dispatchSkill(['doctor', '--fix']);
      assert.notEqual(exit, 0);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
