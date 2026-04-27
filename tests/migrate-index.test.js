import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createTempDir, cleanTempDir, writeJson, readJson, readText, fileExists } from './helpers.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..');

// Helper: count occurrences of a substring in a string
function countOccurrences(str, sub) {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(sub, pos)) !== -1) {
    count++;
    pos += sub.length;
  }
  return count;
}

describe('robin migrate-index', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir();

    // Write config
    writeJson(tmpDir, 'robin.config.json', {
      version: '2.0.0',
      initialized: true,
      platform: 'claude-code',
      user: { name: 'Kevin', timezone: 'America/New_York', email: 'k@test.com' },
      assistant: { name: 'Robin' },
      integrations: [],
    });

    // profile.md — People section with Dr. Smith and Alex Chen
    writeFileSync(join(tmpDir, 'profile.md'), [
      '# Profile',
      '',
      '## People',
      '',
      '- **Dr. Smith**',
      '  - Role: Primary Care Physician',
      '  - Phone: 555-1234',
      '- **Alex Chen**',
      '  - Role: Best friend',
      '  - Met: 2020',
      '',
    ].join('\n'));

    // journal.md — 2 dated entries
    writeFileSync(join(tmpDir, 'journal.md'), [
      '# Journal',
      '',
      'Append-only. Newest at the bottom.',
      '',
      '<!-- APPEND-ONLY below this line -->',
      '',
      '**2026-04-20**',
      'Had coffee with Alex. Great conversation about the future.',
      '',
      '**2026-04-21**',
      'Launched Robin v2 today. Feeling accomplished.',
      '',
    ].join('\n'));

    // tasks.md — 3 items across Work/Personal sections
    writeFileSync(join(tmpDir, 'tasks.md'), [
      '# Tasks',
      '',
      '## Work',
      '',
      '- [ ] Ship Robin v2.1.0',
      '- [x] Write unit tests',
      '',
      '## Personal',
      '',
      '- [ ] Call Dr. Smith',
      '',
    ].join('\n'));

    // knowledge.md — empty
    writeFileSync(join(tmpDir, 'knowledge.md'), [
      '# Knowledge',
      '',
    ].join('\n'));

    // decisions.md — empty
    writeFileSync(join(tmpDir, 'decisions.md'), [
      '# Decisions',
      '',
      'Append-only. Newest at the bottom.',
      '',
      '<!-- APPEND-ONLY below this line -->',
      '',
    ].join('\n'));

    // inbox.md — empty
    writeFileSync(join(tmpDir, 'inbox.md'), [
      '# Inbox',
      '',
      '<!-- APPEND-ONLY below this line -->',
      '',
    ].join('\n'));

    // self-improvement.md — empty
    writeFileSync(join(tmpDir, 'self-improvement.md'), [
      '# Self-Improvement',
      '',
      '## Corrections',
      '',
      '## Patterns',
      '',
    ].join('\n'));
  });

  after(() => { cleanTempDir(tmpDir); });

  it('creates backup, injects IDs, generates indexes and manifest', async () => {
    const { migrateIndexInDir } = await import('../scripts/migrate-index.js');
    await migrateIndexInDir(tmpDir);

    // --- Backup ---
    const archiveDir = join(tmpDir, 'archive');
    assert.ok(existsSync(archiveDir), 'archive/ directory exists');
    const archiveEntries = readdirSync(archiveDir);
    const preIndexBackup = archiveEntries.find(e => e.startsWith('pre-index-'));
    assert.ok(preIndexBackup, `pre-index-* backup exists in archive/, got: [${archiveEntries.join(', ')}]`);

    // --- profile.md: IDs injected, content preserved ---
    const profileContent = readText(tmpDir, 'profile.md');
    assert.ok(profileContent.includes('<!-- id:'), 'profile.md has <!-- id: markers');
    assert.ok(profileContent.includes('Dr. Smith'), 'profile.md preserves Dr. Smith');
    assert.ok(profileContent.includes('Alex Chen'), 'profile.md preserves Alex Chen');

    // --- journal.md: IDs injected, content preserved ---
    const journalContent = readText(tmpDir, 'journal.md');
    assert.ok(journalContent.includes('<!-- id:'), 'journal.md has <!-- id: markers');
    assert.ok(journalContent.includes('coffee with Alex'), 'journal.md preserves first entry');
    assert.ok(journalContent.includes('Launched Robin v2'), 'journal.md preserves second entry');

    // --- tasks.md: IDs injected ---
    const tasksContent = readText(tmpDir, 'tasks.md');
    assert.ok(tasksContent.includes('<!-- id:'), 'tasks.md has <!-- id: markers');

    // --- All 8 index files exist ---
    const expectedIndexFiles = [
      'profile.idx.md',
      'knowledge.idx.md',
      'tasks.idx.md',
      'journal.idx.md',
      'decisions.idx.md',
      'self-improvement.idx.md',
      'inbox.idx.md',
      'trips.idx.md',
    ];
    for (const idxFile of expectedIndexFiles) {
      assert.ok(
        existsSync(join(tmpDir, 'index', idxFile)),
        `index/${idxFile} exists`
      );
    }

    // --- Profile index has entity: dr-smith and enriched: false ---
    const profileIdx = readText(tmpDir, 'index', 'profile.idx.md');
    assert.ok(profileIdx.includes('entity: dr-smith'), 'profile index has entity: dr-smith');
    assert.ok(profileIdx.includes('enriched: false'), 'profile index has enriched: false');

    // --- Journal index has summary: ~ ---
    const journalIdx = readText(tmpDir, 'index', 'journal.idx.md');
    assert.ok(journalIdx.includes('summary: ~'), 'journal index has summary: ~');

    // --- manifest.md exists and includes file: profile and file: journal ---
    assert.ok(existsSync(join(tmpDir, 'manifest.md')), 'manifest.md exists');
    const manifestContent = readFileSync(join(tmpDir, 'manifest.md'), 'utf-8');
    assert.ok(manifestContent.includes('file: profile'), 'manifest includes file: profile');
    assert.ok(manifestContent.includes('file: journal'), 'manifest includes file: journal');

    // --- Config updated to v2.1.0 ---
    const config = readJson(tmpDir, 'robin.config.json');
    assert.equal(config.version, '2.1.0', 'config version is 2.1.0');
    assert.equal(config.indexing?.status, 'structural', 'indexing.status is structural');
    assert.ok(config.indexing?.migrated_at, 'indexing.migrated_at exists');
  });

  it('is idempotent — re-running skips existing IDs and regenerates indexes', async () => {
    // Run migration again on already-migrated workspace
    const { migrateIndexInDir } = await import('../scripts/migrate-index.js');
    await migrateIndexInDir(tmpDir);

    // Profile has 2 entries (Dr. Smith, Alex Chen)
    // Count <!-- id: occurrences — should be exactly 2, not 4
    const profileContent = readText(tmpDir, 'profile.md');
    const idCount = countOccurrences(profileContent, '<!-- id:');
    assert.equal(idCount, 2, `profile.md should have exactly 2 <!-- id: markers (got ${idCount}) — re-running must not duplicate IDs`);

    // Journal has 2 entries — count <!-- id: markers
    const journalContent = readText(tmpDir, 'journal.md');
    const journalIdCount = countOccurrences(journalContent, '<!-- id:');
    assert.equal(journalIdCount, 2, `journal.md should have exactly 2 <!-- id: markers (got ${journalIdCount})`);

    // Tasks has 3 entries — count <!-- id: markers
    const tasksContent = readText(tmpDir, 'tasks.md');
    const tasksIdCount = countOccurrences(tasksContent, '<!-- id:');
    assert.equal(tasksIdCount, 3, `tasks.md should have exactly 3 <!-- id: markers (got ${tasksIdCount})`);

    // Config version stays at 2.1.0
    const config = readJson(tmpDir, 'robin.config.json');
    assert.equal(config.version, '2.1.0', 'config version stays at 2.1.0');

    // Only one backup should exist (pre-index-* is not created again)
    const archiveEntries = readdirSync(join(tmpDir, 'archive'));
    const preIndexBackups = archiveEntries.filter(e => e.startsWith('pre-index-'));
    assert.equal(preIndexBackups.length, 1, 'only one pre-index-* backup created (idempotent)');
  });
});
