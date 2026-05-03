import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as migration from '../../migrations/0003-flatten-memory.js';
import { createHelpers } from '../../scripts/migrate/lib/migration-helpers.js';

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  const ud = join(root, 'user-data');
  mkdirSync(join(ud, 'memory/index'), { recursive: true });
  mkdirSync(join(ud, 'trips'), { recursive: true });
  mkdirSync(join(ud, 'state/locks'), { recursive: true });

  writeFileSync(join(ud, 'memory/knowledge.md'), [
    '# Knowledge',
    '',
    '## Locations',
    '',
    '- 123 Main St — home <!-- id:20260427-0000-mig001 -->',
    '',
    '## Medical',
    '',
    '- Dr. A — primary care <!-- id:20260427-0000-mig002 -->',
  ].join('\n') + '\n');

  writeFileSync(join(ud, 'memory/profile.md'), [
    '# Profile',
    '',
    '## Identity',
    '',
    '- Name: Test',
  ].join('\n') + '\n');

  writeFileSync(join(ud, 'memory/decisions.md'), '# Decisions\n');
  writeFileSync(join(ud, 'memory/journal.md'), '# Journal\n');
  writeFileSync(join(ud, 'memory/tasks.md'), '# Tasks\n');
  writeFileSync(join(ud, 'memory/self-improvement.md'), '# Self-Improvement\n');
  writeFileSync(join(ud, 'memory/inbox.md'), '# Inbox\n\n- [fact] x <!-- id:20260427-0000-cc01 -->\n');

  writeFileSync(join(ud, 'memory/index/knowledge.idx.md'), '# stale index\n');

  writeFileSync(join(ud, 'trips/sample-2026.md'), '# Sample Trip\n\nA brief description of the trip.\n');
  writeFileSync(join(ud, 'trips/_template.md'), '# Trip Template\n\nUse this for new trips.\n');

  writeFileSync(join(ud, 'robin.config.json'), JSON.stringify({
    version: '3.0.0',
    user: { name: 'Test' },
  }, null, 2));

  return { root, ud };
}

test('migration scaffold exposes id and description', () => {
  assert.equal(migration.id, '0003-flatten-memory');
  assert.match(migration.description, /Drop sidecar/);
});

test('migration preserves knowledge.md and profile.md as monoliths with frontmatter', async () => {
  const { root, ud } = setupFixture();
  const helpers = createHelpers(root);
  await migration.up({ workspaceDir: root, helpers, opts: { interactive: false } });

  // Monoliths preserved (Phase 1 — no auto-split)
  assert.ok(existsSync(join(ud, 'memory/knowledge.md')));
  assert.ok(existsSync(join(ud, 'memory/profile.md')));
  // No profile topic folder auto-created
  assert.equal(existsSync(join(ud, 'memory/profile')), false);
  // knowledge/ exists only to hold events/ — no topic files split out from knowledge.md
  const knowledgeEntries = existsSync(join(ud, 'memory/knowledge'))
    ? readdirSync(join(ud, 'memory/knowledge'))
    : [];
  assert.deepEqual(knowledgeEntries.filter((n) => n !== 'events'), []);
  // Frontmatter added
  const k = readFileSync(join(ud, 'memory/knowledge.md'), 'utf-8');
  assert.match(k, /^---\ndescription:.+monolith.+split-monoliths/);
  const p = readFileSync(join(ud, 'memory/profile.md'), 'utf-8');
  assert.match(p, /^---\ndescription:/);
  // Inline pointer IDs stripped from monoliths (sidecar is gone)
  assert.equal(k.includes('mig001'), false);
  assert.equal(k.includes('mig002'), false);
  // Inbox pointer IDs preserved
  const inbox = readFileSync(join(ud, 'memory/inbox.md'), 'utf-8');
  assert.match(inbox, /id:20260427-0000-cc01/);

  rmSync(root, { recursive: true, force: true });
});

test('migration deletes sidecar index tree', async () => {
  const { root, ud } = setupFixture();
  const helpers = createHelpers(root);
  await migration.up({ workspaceDir: root, helpers, opts: { interactive: false } });
  assert.equal(existsSync(join(ud, 'memory/index')), false);
  rmSync(root, { recursive: true, force: true });
});

test('migration relocates trips/ to memory/knowledge/events/ with frontmatter', async () => {
  const { root, ud } = setupFixture();
  const helpers = createHelpers(root);
  await migration.up({ workspaceDir: root, helpers, opts: { interactive: false } });

  assert.equal(existsSync(join(ud, 'trips')), false);
  assert.ok(existsSync(join(ud, 'memory/knowledge/events/sample-2026.md')));
  assert.ok(existsSync(join(ud, 'memory/knowledge/events/_template.md')));
  const sample = readFileSync(join(ud, 'memory/knowledge/events/sample-2026.md'), 'utf-8');
  assert.match(sample, /^---\ndescription:/);

  rmSync(root, { recursive: true, force: true });
});

test('migration adds frontmatter to flat files and generates INDEX.md', async () => {
  const { root, ud } = setupFixture();
  const helpers = createHelpers(root);
  await migration.up({ workspaceDir: root, helpers, opts: { interactive: false } });

  for (const name of ['inbox.md', 'decisions.md', 'journal.md', 'tasks.md', 'self-improvement.md']) {
    const content = readFileSync(join(ud, 'memory', name), 'utf-8');
    assert.match(content, /^---\ndescription:/, `${name} should have frontmatter`);
  }
  assert.ok(existsSync(join(ud, 'memory/INDEX.md')));
  const indexContent = readFileSync(join(ud, 'memory/INDEX.md'), 'utf-8');
  assert.match(indexContent, /knowledge\.md/);
  assert.match(indexContent, /profile\.md/);
  assert.match(indexContent, /events\/sample-2026\.md/);

  rmSync(root, { recursive: true, force: true });
});

test('migration is idempotent on already-migrated frontmatter', async () => {
  const { root, ud } = setupFixture();
  const helpers = createHelpers(root);
  await migration.up({ workspaceDir: root, helpers, opts: { interactive: false } });
  const before = readFileSync(join(ud, 'memory/knowledge.md'), 'utf-8');
  // Re-run: no error, content unchanged
  await migration.up({ workspaceDir: root, helpers, opts: { interactive: false } });
  const after = readFileSync(join(ud, 'memory/knowledge.md'), 'utf-8');
  assert.equal(after, before);
  rmSync(root, { recursive: true, force: true });
});
