import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createTempDir, cleanTempDir, readJson, fileExists } from './helpers.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..');

describe('robin init', () => {
  let tmpDir;

  before(() => { tmpDir = createTempDir(); });
  after(() => { cleanTempDir(tmpDir); });

  it('scaffolds all expected files for claude-code platform', async () => {
    const { initWithOptions } = await import('../scripts/init.js');
    const targetDir = join(tmpDir, 'workspace');
    await initWithOptions(targetDir, {
      force: true,
      platform: 'claude-code',
      name: 'Test User',
      timezone: 'America/New_York',
    }, PKG_ROOT);

    assert.ok(fileExists(targetDir, 'AGENTS.md'), 'AGENTS.md exists');
    assert.ok(fileExists(targetDir, 'CLAUDE.md'), 'CLAUDE.md pointer exists');
    assert.ok(fileExists(targetDir, 'startup.md'), 'startup.md exists');
    assert.ok(fileExists(targetDir, 'capture-rules.md'), 'capture-rules.md exists');
    assert.ok(fileExists(targetDir, 'integrations.md'), 'integrations.md exists');
    assert.ok(fileExists(targetDir, 'profile.md'), 'profile.md exists');
    assert.ok(fileExists(targetDir, 'tasks.md'), 'tasks.md exists');
    assert.ok(fileExists(targetDir, 'knowledge.md'), 'knowledge.md exists');
    assert.ok(fileExists(targetDir, 'decisions.md'), 'decisions.md exists');
    assert.ok(fileExists(targetDir, 'journal.md'), 'journal.md exists');
    assert.ok(fileExists(targetDir, 'self-improvement.md'), 'self-improvement.md exists');
    assert.ok(fileExists(targetDir, 'inbox.md'), 'inbox.md exists');
    assert.ok(fileExists(targetDir, 'state', 'sessions.md'), 'state/sessions.md exists');
    assert.ok(fileExists(targetDir, 'state', 'dream-state.md'), 'state/dream-state.md exists');
    assert.ok(existsSync(join(targetDir, 'state', 'locks')), 'state/locks/ exists');
    assert.ok(existsSync(join(targetDir, 'artifacts')), 'artifacts/ exists');
    assert.ok(fileExists(targetDir, 'protocols', 'INDEX.md'), 'protocols/INDEX.md exists');
    assert.ok(fileExists(targetDir, 'protocols', 'dream.md'), 'protocols/dream.md exists');

    const config = readJson(targetDir, 'arc.config.json');
    assert.equal(config.platform, 'claude-code');
    assert.equal(config.user.name, 'Test User');
    assert.equal(config.user.timezone, 'America/New_York');
    assert.equal(config.initialized, true);

    const pointer = readFileSync(join(targetDir, 'CLAUDE.md'), 'utf-8');
    assert.ok(pointer.includes('AGENTS.md'), 'CLAUDE.md points to AGENTS.md');
  });

  it('scaffolds cursor platform with .cursorrules', async () => {
    const { initWithOptions } = await import('../scripts/init.js');
    const targetDir = join(tmpDir, 'cursor-ws');
    await initWithOptions(targetDir, {
      force: true,
      platform: 'cursor',
      name: 'Test',
      timezone: 'UTC',
    }, PKG_ROOT);

    assert.ok(fileExists(targetDir, '.cursorrules'), '.cursorrules exists');
    assert.ok(!fileExists(targetDir, 'CLAUDE.md'), 'no CLAUDE.md for cursor');
  });

  it('scaffolds codex platform with no pointer file', async () => {
    const { initWithOptions } = await import('../scripts/init.js');
    const targetDir = join(tmpDir, 'codex-ws');
    await initWithOptions(targetDir, {
      force: true,
      platform: 'codex',
      name: 'Test',
      timezone: 'UTC',
    }, PKG_ROOT);

    assert.ok(fileExists(targetDir, 'AGENTS.md'), 'AGENTS.md exists');
    assert.ok(!fileExists(targetDir, 'CLAUDE.md'), 'no CLAUDE.md for codex');
    assert.ok(!fileExists(targetDir, '.cursorrules'), 'no .cursorrules for codex');
  });
});
