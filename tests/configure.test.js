import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createTempDir, cleanTempDir, writeJson, readJson, fileExists, readText } from './helpers.js';

describe('arc configure', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir();
    writeJson(tmpDir, 'arc.config.json', {
      version: '2.0.0', initialized: true, platform: 'claude-code',
      user: { name: 'Test', timezone: 'UTC', email: null },
      assistant: { name: 'Arc' }, integrations: ['email'],
    });
    writeFileSync(join(tmpDir, 'CLAUDE.md'), 'Read and follow AGENTS.md for all instructions.\n');
    writeFileSync(join(tmpDir, 'integrations.md'), '# Integrations\n');
  });
  after(() => { cleanTempDir(tmpDir); });

  it('switches platform from claude-code to cursor', async () => {
    const { configureInDir } = await import('../scripts/configure.js');
    await configureInDir(tmpDir, { platform: 'cursor' });

    const config = readJson(tmpDir, 'arc.config.json');
    assert.equal(config.platform, 'cursor');
    assert.ok(fileExists(tmpDir, '.cursorrules'), '.cursorrules created');
    assert.ok(!fileExists(tmpDir, 'CLAUDE.md'), 'CLAUDE.md removed');
  });

  it('updates user name', async () => {
    const { configureInDir } = await import('../scripts/configure.js');
    await configureInDir(tmpDir, { name: 'New Name' });

    const config = readJson(tmpDir, 'arc.config.json');
    assert.equal(config.user.name, 'New Name');
  });

  it('adds an integration', async () => {
    const { configureInDir } = await import('../scripts/configure.js');
    await configureInDir(tmpDir, { addIntegration: 'calendar' });

    const config = readJson(tmpDir, 'arc.config.json');
    assert.ok(config.integrations.includes('calendar'));
    const intMd = readText(tmpDir, 'integrations.md');
    assert.ok(intMd.includes('calendar'));
  });
});
