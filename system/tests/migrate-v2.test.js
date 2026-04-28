import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createTempDir, cleanTempDir, writeJson, readJson, readText, fileExists } from './helpers.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..', '..');

describe('robin migrate-v2', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir();

    writeJson(tmpDir, 'arc.config.json', {
      version: '1.0.0', initialized: true,
      user: { name: 'Kevin', timezone: 'America/New_York', email: 'k@test.com' },
      assistant: { name: 'Robin' },
      features: { dream: true, multiSession: true, autoUpdateCheck: true },
      integrations: [],
    });
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# old CLAUDE.md\n');

    mkdirSync(join(tmpDir, 'profile'), { recursive: true });
    writeFileSync(join(tmpDir, 'profile', 'identity.md'), '# Identity\n\n- **Name:** Kevin\n');
    writeFileSync(join(tmpDir, 'profile', 'goals.md'), '# Goals\n\n- Learn Rust\n');

    mkdirSync(join(tmpDir, 'todos'), { recursive: true });
    writeFileSync(join(tmpDir, 'todos', 'work.md'), '# Work\n\n- [ ] Ship v2\n');
    writeFileSync(join(tmpDir, 'todos', 'personal.md'), '# Personal\n\n- [ ] Grocery run\n');

    mkdirSync(join(tmpDir, 'knowledge', 'vendors'), { recursive: true });
    writeFileSync(join(tmpDir, 'knowledge', 'vendors', 'README.md'), '# Vendors\n');
    mkdirSync(join(tmpDir, 'knowledge', 'medical'), { recursive: true });
    writeFileSync(join(tmpDir, 'knowledge', 'medical', 'README.md'), '# Medical\n\nDr. Smith - PCP\n');

    mkdirSync(join(tmpDir, 'self-improvement'), { recursive: true });
    writeFileSync(join(tmpDir, 'self-improvement', 'corrections.md'), '# Corrections\n\n- Fixed date format\n');
    writeFileSync(join(tmpDir, 'self-improvement', 'session-handoff.md'), '# Session Handoff\n\nWorking on v2 migration.\n');
    writeFileSync(join(tmpDir, 'self-improvement', 'mistakes.md'), '# Mistakes\n\n- Forgot timezone\n');

    mkdirSync(join(tmpDir, 'memory', 'short-term'), { recursive: true });
    mkdirSync(join(tmpDir, 'memory', 'long-term'), { recursive: true });
    writeFileSync(join(tmpDir, 'memory', 'short-term', 'last-dream.md'),
      '# Last Dream\n\nlast_dream_at: 2026-04-25T10:00:00Z\nsessions_since: 3\nstatus: ran\n');
    writeFileSync(join(tmpDir, 'memory', 'long-term', 'financial.md'), '# Financial\n\nSavings: 50k\n');

    mkdirSync(join(tmpDir, 'inbox'), { recursive: true });
    writeFileSync(join(tmpDir, 'inbox', 'inbox.md'), '# Inbox\n\n- Random thought\n');
    mkdirSync(join(tmpDir, 'decisions'), { recursive: true });
    mkdirSync(join(tmpDir, 'journal'), { recursive: true });
    mkdirSync(join(tmpDir, 'core', 'protocols'), { recursive: true });
    mkdirSync(join(tmpDir, 'archive'), { recursive: true });
    mkdirSync(join(tmpDir, 'overrides'), { recursive: true });
    mkdirSync(join(tmpDir, 'skills'), { recursive: true });
    mkdirSync(join(tmpDir, 'share'), { recursive: true });
  });

  after(() => { cleanTempDir(tmpDir); });

  it('migrates a v1 workspace to v2 structure', async () => {
    const { migrateV2InDir } = await import('../scripts/migrate-v2.js');
    await migrateV2InDir(tmpDir, PKG_ROOT);

    assert.ok(fileExists(tmpDir, 'AGENTS.md'), 'AGENTS.md exists');
    assert.ok(fileExists(tmpDir, 'profile.md'), 'profile.md exists');
    assert.ok(fileExists(tmpDir, 'tasks.md'), 'tasks.md exists');
    assert.ok(fileExists(tmpDir, 'knowledge.md'), 'knowledge.md exists');
    assert.ok(fileExists(tmpDir, 'self-improvement.md'), 'self-improvement.md exists');
    assert.ok(fileExists(tmpDir, 'inbox.md'), 'inbox.md exists');
    assert.ok(fileExists(tmpDir, 'state', 'dream-state.md'), 'dream-state.md exists');
    assert.ok(fileExists(tmpDir, 'protocols', 'INDEX.md'), 'protocols/INDEX.md exists');

    const profile = readText(tmpDir, 'profile.md');
    assert.ok(profile.includes('Kevin'), 'profile has identity content');
    assert.ok(profile.includes('Learn Rust'), 'profile has goals content');

    const tasks = readText(tmpDir, 'tasks.md');
    assert.ok(tasks.includes('Ship v2'), 'tasks has work content');
    assert.ok(tasks.includes('Grocery run'), 'tasks has personal content');

    const knowledge = readText(tmpDir, 'knowledge.md');
    assert.ok(knowledge.includes('Dr. Smith'), 'knowledge has medical content');

    const si = readText(tmpDir, 'self-improvement.md');
    assert.ok(si.includes('Fixed date format'), 'has corrections');
    assert.ok(si.includes('Working on v2'), 'has session handoff');

    assert.ok(knowledge.includes('Savings: 50k') || knowledge.includes('Migrated'), 'long-term memory migrated');

    const dreamState = readText(tmpDir, 'state', 'dream-state.md');
    assert.ok(dreamState.includes('2026-04-25'), 'dream state has last_dream_at');

    const config = readJson(tmpDir, 'arc.config.json');
    assert.equal(config.version, '2.0.0');
    assert.equal(config.platform, 'claude-code');
    assert.ok(!config.features, 'features removed');

    assert.ok(!existsSync(join(tmpDir, 'core')), 'core/ removed');
    assert.ok(!existsSync(join(tmpDir, 'memory')), 'memory/ removed');
    assert.ok(!existsSync(join(tmpDir, 'overrides')), 'overrides/ removed');
    assert.ok(existsSync(join(tmpDir, 'share')), 'share/ preserved (not deleted)');

    const archiveEntries = readdirSync(join(tmpDir, 'archive'));
    const preV2 = archiveEntries.find(e => e.startsWith('pre-v2-'));
    assert.ok(preV2, 'pre-v2 backup exists');
  });

  it('extracts integration names from objects', async () => {
    const tmpDir2 = createTempDir();
    try {
      writeJson(tmpDir2, 'arc.config.json', {
        version: '1.0.0', initialized: true,
        user: { name: 'Test', timezone: 'UTC', email: 't@test.com' },
        assistant: { name: 'Robin' },
        integrations: [
          { name: 'calendar', type: 'mcp', provider: 'google-calendar' },
          { name: 'weather', type: 'mcp', provider: 'custom' },
          'email',
        ],
      });
      mkdirSync(join(tmpDir2, 'core'), { recursive: true });

      const { migrateV2InDir } = await import('../scripts/migrate-v2.js');
      await migrateV2InDir(tmpDir2, PKG_ROOT);

      const config = readJson(tmpDir2, 'arc.config.json');
      assert.deepEqual(config.integrations, ['calendar', 'weather', 'email']);

      const intMd = readFileSync(join(tmpDir2, 'integrations.md'), 'utf-8');
      assert.ok(intMd.includes('calendar'), 'integrations.md lists calendar');
      assert.ok(intMd.includes('weather'), 'integrations.md lists weather');
      assert.ok(intMd.includes('email'), 'integrations.md lists email');
    } finally {
      cleanTempDir(tmpDir2);
    }
  });

  it('preserves non-md files from knowledge to artifacts', async () => {
    const tmpDir3 = createTempDir();
    try {
      writeJson(tmpDir3, 'arc.config.json', {
        version: '1.0.0', initialized: true,
        user: { name: 'Test', timezone: 'UTC', email: 't@test.com' },
        assistant: { name: 'Robin' },
        integrations: [],
      });
      mkdirSync(join(tmpDir3, 'knowledge', 'photos'), { recursive: true });
      writeFileSync(join(tmpDir3, 'knowledge', 'photos', 'data.json'), '{"test": true}');
      writeFileSync(join(tmpDir3, 'knowledge', 'photos', 'notes.md'), '# Notes\n\nSome notes\n');
      mkdirSync(join(tmpDir3, 'core'), { recursive: true });

      const { migrateV2InDir } = await import('../scripts/migrate-v2.js');
      await migrateV2InDir(tmpDir3, PKG_ROOT);

      assert.ok(
        existsSync(join(tmpDir3, 'artifacts', 'knowledge', 'photos', 'data.json')),
        'non-md file preserved in artifacts/'
      );
      assert.ok(
        !existsSync(join(tmpDir3, 'artifacts', 'knowledge', 'photos', 'notes.md')),
        'md files not duplicated to artifacts/'
      );
    } finally {
      cleanTempDir(tmpDir3);
    }
  });

  it('cleans up old .state directory', async () => {
    const tmpDir4 = createTempDir();
    try {
      writeJson(tmpDir4, 'arc.config.json', {
        version: '1.0.0', initialized: true,
        user: { name: 'Test', timezone: 'UTC', email: 't@test.com' },
        assistant: { name: 'Robin' },
        integrations: [],
      });
      mkdirSync(join(tmpDir4, '.state', 'coordination'), { recursive: true });
      mkdirSync(join(tmpDir4, 'core'), { recursive: true });

      const { migrateV2InDir } = await import('../scripts/migrate-v2.js');
      await migrateV2InDir(tmpDir4, PKG_ROOT);

      assert.ok(!existsSync(join(tmpDir4, '.state')), '.state/ removed');
      assert.ok(existsSync(join(tmpDir4, 'state')), 'state/ created');
    } finally {
      cleanTempDir(tmpDir4);
    }
  });
});
