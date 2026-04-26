import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createTempDir, cleanTempDir, writeJson } from './helpers.js';

describe('arc validate', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir();
    writeJson(tmpDir, 'arc.config.json', {
      version: '2.0.0', initialized: true, platform: 'claude-code',
      user: { name: 'Test', timezone: 'UTC', email: null },
      assistant: { name: 'Arc' }, integrations: [],
    });
    for (const f of ['AGENTS.md','startup.md','capture-rules.md','integrations.md',
      'profile.md','tasks.md','knowledge.md','decisions.md','journal.md',
      'self-improvement.md','inbox.md']) {
      writeFileSync(join(tmpDir, f), '# placeholder\n');
    }
    mkdirSync(join(tmpDir, 'state', 'locks'), { recursive: true });
    writeFileSync(join(tmpDir, 'state', 'sessions.md'), '# Active Sessions\n');
    writeFileSync(join(tmpDir, 'state', 'dream-state.md'), '# Dream State\n');
    mkdirSync(join(tmpDir, 'protocols'), { recursive: true });
    writeFileSync(join(tmpDir, 'protocols', 'INDEX.md'), '# Protocols\n');
  });
  after(() => { cleanTempDir(tmpDir); });

  it('passes validation on a complete workspace', async () => {
    const { validateInDir } = await import('../scripts/validate.js');
    const result = await validateInDir(tmpDir);
    assert.equal(result.issues, 0);
  });

  it('detects missing files', async () => {
    const { validateInDir } = await import('../scripts/validate.js');
    const sparseDir = createTempDir();
    writeJson(sparseDir, 'arc.config.json', {
      version: '2.0.0', initialized: true, platform: 'claude-code',
      user: { name: 'Test', timezone: 'UTC' }, assistant: { name: 'Arc' }, integrations: [],
    });
    const result = await validateInDir(sparseDir);
    assert.ok(result.issues > 0, 'should find missing files');
    cleanTempDir(sparseDir);
  });
});
