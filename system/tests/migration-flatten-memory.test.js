import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as migration from '../migrations/0003-flatten-memory.js';
import { createHelpers } from '../scripts/lib/migration-helpers.js';

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  const ud = join(root, 'user-data');
  mkdirSync(join(ud, 'memory/index'), { recursive: true });
  mkdirSync(join(ud, 'trips'), { recursive: true });
  mkdirSync(join(ud, 'state/locks'), { recursive: true });

  // Pre-existing flat memory files (mimicking real layout where domain headings
  // are level-2 with smaller level-2 sub-sections under them)
  writeFileSync(join(ud, 'memory/knowledge.md'), [
    '# Knowledge',
    '',
    '## Locations',
    '',
    '- 123 Main St — home address',
    '- 456 Park Ave — parents',
    '',
    '## Medical',
    '',
    '- Dr. A — primary care',
    '- Dr. B — dentist',
    '- Dr. C — dermatology',
    '',
    '## Recipes',
    '',
    '- Recipe X — pasta carbonara',
    '- Recipe Y — chicken tikka',
  ].join('\n') + '\n');

  writeFileSync(join(ud, 'memory/profile.md'), [
    '# Profile',
    '',
    '## Identity',
    '',
    '- Name: Test',
    '- Location: NYC',
    '- Age: 30',
    '',
    '## Routines',
    '',
    '- Morning: walk',
    '- Evening: read',
    '- Weekly: gym Tu/Th',
  ].join('\n') + '\n');

  writeFileSync(join(ud, 'memory/decisions.md'), '# Decisions\n');
  writeFileSync(join(ud, 'memory/journal.md'), '# Journal\n');
  writeFileSync(join(ud, 'memory/tasks.md'), '# Tasks\n');
  writeFileSync(join(ud, 'memory/self-improvement.md'), '# Self-Improvement\n');
  writeFileSync(join(ud, 'memory/inbox.md'), '# Inbox\n');

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
  assert.match(migration.description, /Flatten memory/);
});

test('migration runs with non-interactive defaults — full integration', async () => {
  const { root, ud } = setupFixture();
  const helpers = createHelpers(root);
  await migration.up({ workspaceDir: root, helpers, opts: { interactive: false } });

  // Sidecars deleted
  assert.equal(existsSync(join(ud, 'memory/index')), false);
  // trips relocated
  assert.equal(existsSync(join(ud, 'trips')), false);
  assert.ok(existsSync(join(ud, 'memory/events/sample-2026.md')));
  assert.ok(existsSync(join(ud, 'memory/events/_template.md')));
  // Old monoliths gone
  assert.equal(existsSync(join(ud, 'memory/knowledge.md')), false);
  assert.equal(existsSync(join(ud, 'memory/profile.md')), false);
  // New topic files present
  assert.ok(existsSync(join(ud, 'memory/knowledge/locations.md')));
  assert.ok(existsSync(join(ud, 'memory/knowledge/medical.md')));
  assert.ok(existsSync(join(ud, 'memory/knowledge/recipes.md')));
  assert.ok(existsSync(join(ud, 'memory/profile/identity.md')));
  assert.ok(existsSync(join(ud, 'memory/profile/routines.md')));
  // INDEX.md generated and includes the new files
  const indexContent = readFileSync(join(ud, 'memory/INDEX.md'), 'utf-8');
  assert.match(indexContent, /knowledge\/medical\.md/);
  assert.match(indexContent, /profile\/identity\.md/);
  assert.match(indexContent, /events\/sample-2026\.md/);
  // Flat files retain frontmatter
  const inboxContent = readFileSync(join(ud, 'memory/inbox.md'), 'utf-8');
  assert.match(inboxContent, /^---\ndescription:/);

  rmSync(root, { recursive: true, force: true });
});
