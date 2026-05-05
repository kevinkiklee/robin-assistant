import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchSkill } from '../../scripts/cli/skill.js';
import { generateIndex } from '../../scripts/lib/external-skill-loader.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/external-skills');

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'robin-skill-cli-'));
  mkdirSync(join(ws, 'bin'), { recursive: true });
  writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(ws, 'user-data', 'skills', 'external'), { recursive: true });
  return ws;
}

async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(typeof s === 'string' ? s : s.toString()); return true; };
  try { const r = await fn(); return { result: r, output: chunks.join('') }; }
  finally { process.stdout.write = orig; }
}

describe('robin skill list', () => {
  it('prints empty INDEX when no skills installed', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    try {
      generateIndex(ws);
      const { result, output } = await captureStdout(() => dispatchSkill(['list']));
      assert.equal(result, 0);
      assert.match(output, /no skills installed/);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('prints INDEX content with installed skills', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    cpSync(join(FIXTURES, 'valid-basic'), join(ws, 'user-data/skills/external/valid-basic'), { recursive: true });
    try {
      generateIndex(ws);
      const { result, output } = await captureStdout(() => dispatchSkill(['list']));
      assert.equal(result, 0);
      assert.match(output, /valid-basic/);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('robin skill show', () => {
  it('prints SKILL.md body when skill exists', async () => {
    const ws = makeWorkspace();
    const prev = process.env.ROBIN_WORKSPACE;
    process.env.ROBIN_WORKSPACE = ws;
    cpSync(join(FIXTURES, 'valid-basic'), join(ws, 'user-data/skills/external/valid-basic'), { recursive: true });
    try {
      const { result, output } = await captureStdout(() => dispatchSkill(['show', 'valid-basic']));
      assert.equal(result, 0);
      assert.match(output, /name: valid-basic/);
      assert.match(output, /# Valid Basic/);
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
      const { result } = await captureStdout(() => dispatchSkill(['show', 'does-not-exist']));
      assert.notEqual(result, 0);
    } finally {
      process.env.ROBIN_WORKSPACE = prev;
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
