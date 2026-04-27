import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createTempDir, cleanTempDir, writeJson } from './helpers.js';

describe('robin validate', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir();
    writeJson(tmpDir, 'robin.config.json', {
      version: '2.0.0', initialized: true, platform: 'claude-code',
      user: { name: 'Test', timezone: 'UTC', email: null },
      assistant: { name: 'Robin' }, integrations: [],
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
    writeJson(sparseDir, 'robin.config.json', {
      version: '2.0.0', initialized: true, platform: 'claude-code',
      user: { name: 'Test', timezone: 'UTC' }, assistant: { name: 'Robin' }, integrations: [],
    });
    const result = await validateInDir(sparseDir);
    assert.ok(result.issues > 0, 'should find missing files');
    cleanTempDir(sparseDir);
  });

  it('validates index directory and manifest for v2.1.0 workspaces', async () => {
    const { validateInDir } = await import('../scripts/validate.js');
    const v21Dir = createTempDir();
    try {
      writeJson(v21Dir, 'robin.config.json', {
        version: '2.1.0', initialized: true, platform: 'claude-code',
        user: { name: 'Test', timezone: 'UTC', email: null },
        assistant: { name: 'Robin' }, integrations: [],
        indexing: { status: 'complete', migrated_at: '2026-04-26T00:00:00Z' },
      });
      for (const f of ['AGENTS.md','startup.md','capture-rules.md','integrations.md',
        'profile.md','tasks.md','knowledge.md','decisions.md','journal.md',
        'self-improvement.md','inbox.md']) {
        writeFileSync(join(v21Dir, f), '# placeholder\n');
      }
      mkdirSync(join(v21Dir, 'state', 'locks'), { recursive: true });
      writeFileSync(join(v21Dir, 'state', 'sessions.md'), '# Active Sessions\n');
      writeFileSync(join(v21Dir, 'state', 'dream-state.md'), '# Dream State\n');
      mkdirSync(join(v21Dir, 'protocols'), { recursive: true });
      writeFileSync(join(v21Dir, 'protocols', 'INDEX.md'), '# Protocols\n');
      writeFileSync(join(v21Dir, 'manifest.md'), '# Manifest\n');
      mkdirSync(join(v21Dir, 'index'), { recursive: true });
      for (const f of [
        'profile.idx.md', 'knowledge.idx.md', 'tasks.idx.md',
        'journal.idx.md', 'decisions.idx.md', 'self-improvement.idx.md',
        'inbox.idx.md', 'trips.idx.md',
      ]) {
        writeFileSync(join(v21Dir, 'index', f), '# Index\n');
      }
      const result = await validateInDir(v21Dir);
      assert.equal(result.issues, 0);
    } finally {
      cleanTempDir(v21Dir);
    }
  });

  it('detects missing index files on v2.1.0 workspace', async () => {
    const { validateInDir } = await import('../scripts/validate.js');
    const v21Dir = createTempDir();
    try {
      writeJson(v21Dir, 'robin.config.json', {
        version: '2.1.0', initialized: true, platform: 'claude-code',
        user: { name: 'Test', timezone: 'UTC', email: null },
        assistant: { name: 'Robin' }, integrations: [],
      });
      for (const f of ['AGENTS.md','startup.md','capture-rules.md','integrations.md',
        'profile.md','tasks.md','knowledge.md','decisions.md','journal.md',
        'self-improvement.md','inbox.md']) {
        writeFileSync(join(v21Dir, f), '# placeholder\n');
      }
      mkdirSync(join(v21Dir, 'state', 'locks'), { recursive: true });
      writeFileSync(join(v21Dir, 'state', 'sessions.md'), '# Active Sessions\n');
      writeFileSync(join(v21Dir, 'state', 'dream-state.md'), '# Dream State\n');
      mkdirSync(join(v21Dir, 'protocols'), { recursive: true });
      writeFileSync(join(v21Dir, 'protocols', 'INDEX.md'), '# Protocols\n');
      // Intentionally omit index/ directory and manifest.md
      const result = await validateInDir(v21Dir);
      assert.ok(result.issues > 0, 'should find missing index files');
    } finally {
      cleanTempDir(v21Dir);
    }
  });
});
