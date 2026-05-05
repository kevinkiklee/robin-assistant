import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
});
