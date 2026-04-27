import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('generateEntryId', () => {
  it('returns an ID in YYYYMMDD-HHMM-<session><seq> format', async () => {
    const { generateEntryId } = await import('../scripts/lib/index-utils.js');
    const id = generateEntryId('ab');
    assert.match(id, /^\d{8}-\d{4}-[a-z0-9]{2}[a-z]$/);
  });

  it('uses UTC date and time', async () => {
    const { generateEntryId } = await import('../scripts/lib/index-utils.js');
    const before = new Date();
    const id = generateEntryId('zz');
    const after = new Date();

    // Extract date portion from id
    const datePart = id.slice(0, 8);
    const timePart = id.slice(9, 13);

    // The date and hour should be consistent with UTC now (allowing for minute rollover)
    const y = before.getUTCFullYear().toString();
    const m = String(before.getUTCMonth() + 1).padStart(2, '0');
    const d = String(before.getUTCDate()).padStart(2, '0');

    // Accept before or after day (in edge case of midnight rollover)
    const beforeDate = `${before.getUTCFullYear()}${String(before.getUTCMonth() + 1).padStart(2, '0')}${String(before.getUTCDate()).padStart(2, '0')}`;
    const afterDate = `${after.getUTCFullYear()}${String(after.getUTCMonth() + 1).padStart(2, '0')}${String(after.getUTCDate()).padStart(2, '0')}`;

    assert.ok(datePart >= beforeDate && datePart <= afterDate, `date ${datePart} should be between ${beforeDate} and ${afterDate}`);
  });

  it('starts sequence at a for first call in a given minute', async () => {
    // Import fresh module to get clean state — use dynamic import trick
    const { generateEntryId, _resetSequenceForTest } = await import('../scripts/lib/index-utils.js');
    _resetSequenceForTest();
    const id = generateEntryId('xy');
    // Sequence character should be 'a' (first in minute)
    assert.equal(id.slice(-1), 'a');
  });

  it('increments sequence for subsequent calls in the same minute', async () => {
    const { generateEntryId, _resetSequenceForTest } = await import('../scripts/lib/index-utils.js');
    _resetSequenceForTest();
    const id1 = generateEntryId('xy');
    const id2 = generateEntryId('xy');
    const id3 = generateEntryId('xy');
    assert.equal(id1.slice(-1), 'a');
    assert.equal(id2.slice(-1), 'b');
    assert.equal(id3.slice(-1), 'c');
    // Date+hour+minute prefix should match between calls
    assert.equal(id1.slice(0, 13), id2.slice(0, 13));
  });

  it('embeds the sessionShort in the ID', async () => {
    const { generateEntryId, _resetSequenceForTest } = await import('../scripts/lib/index-utils.js');
    _resetSequenceForTest();
    const id = generateEntryId('ab');
    // session part is the 2 chars after the second dash
    const sessionPart = id.slice(14, 16);
    assert.equal(sessionPart, 'ab');
  });
});

describe('generateMigrationId', () => {
  it('generates <YYYYMMDD>-0000-mig<NN> format', async () => {
    const { generateMigrationId } = await import('../scripts/lib/index-utils.js');
    const id = generateMigrationId(null, 1, '2026-01-15');
    assert.match(id, /^\d{8}-0000-mig\d{2}$/);
  });

  it('uses entryDate when provided', async () => {
    const { generateMigrationId } = await import('../scripts/lib/index-utils.js');
    const id = generateMigrationId('2025-03-07', 1, '2026-01-01');
    assert.ok(id.startsWith('20250307-'), `expected date prefix 20250307, got ${id}`);
  });

  it('falls back to fallbackDate when entryDate is null', async () => {
    const { generateMigrationId } = await import('../scripts/lib/index-utils.js');
    const id = generateMigrationId(null, 3, '2024-06-15');
    assert.ok(id.startsWith('20240615-'), `expected 20240615 prefix, got ${id}`);
  });

  it('falls back to today when both dates are null', async () => {
    const { generateMigrationId } = await import('../scripts/lib/index-utils.js');
    const id = generateMigrationId(null, 1, null);
    const today = new Date();
    const yyyy = today.getUTCFullYear().toString();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    assert.ok(id.startsWith(`${yyyy}${mm}${dd}-`), `expected today prefix, got ${id}`);
  });

  it('zero-pads seq to 2 digits', async () => {
    const { generateMigrationId } = await import('../scripts/lib/index-utils.js');
    const id1 = generateMigrationId('2025-01-01', 1, null);
    const id9 = generateMigrationId('2025-01-01', 9, null);
    const id10 = generateMigrationId('2025-01-01', 10, null);
    assert.ok(id1.endsWith('mig01'), `expected mig01, got ${id1}`);
    assert.ok(id9.endsWith('mig09'), `expected mig09, got ${id9}`);
    assert.ok(id10.endsWith('mig10'), `expected mig10, got ${id10}`);
  });
});

describe('parseAppendOnlyEntries', () => {
  it('returns empty array for content with no APPEND-ONLY marker', async () => {
    const { parseAppendOnlyEntries } = await import('../scripts/lib/index-utils.js');
    const result = parseAppendOnlyEntries('# Journal\n\nSome content\n');
    assert.deepEqual(result, []);
  });

  it('parses blocks after the APPEND-ONLY marker', async () => {
    const { parseAppendOnlyEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Journal

<!-- APPEND-ONLY below — do not edit above this line -->

**2025-01-10**
Had a great day.

**2025-01-11**
Another entry here.
`;
    const entries = parseAppendOnlyEntries(content);
    assert.equal(entries.length, 2);
    assert.ok(entries[0].text.includes('Had a great day'));
    assert.ok(entries[1].text.includes('Another entry here'));
  });

  it('extracts date from **YYYY-MM-DD** pattern', async () => {
    const { parseAppendOnlyEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Decisions

<!-- APPEND-ONLY below — do not edit above this line -->

**2025-03-15**
Decided to use PostgreSQL.
`;
    const entries = parseAppendOnlyEntries(content);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].date, '2025-03-15');
  });

  it('skips blocks that already have <!-- id: markers', async () => {
    const { parseAppendOnlyEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Journal

<!-- APPEND-ONLY below — do not edit above this line -->

<!-- id:20250101-0900-ab01a -->
**2025-01-01**
Already indexed entry.

**2025-01-02**
New unindexed entry.
`;
    const entries = parseAppendOnlyEntries(content);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].text.includes('New unindexed entry'));
  });

  it('returns null date when no date pattern found in block', async () => {
    const { parseAppendOnlyEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Inbox

<!-- APPEND-ONLY below — do not edit above this line -->

Random thought with no date.
`;
    const entries = parseAppendOnlyEntries(content);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].date, null);
  });

  it('handles multiple blank-line-separated blocks', async () => {
    const { parseAppendOnlyEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Journal

<!-- APPEND-ONLY below -->

**2025-01-01**
Entry one.

**2025-01-02**
Entry two.

**2025-01-03**
Entry three.
`;
    const entries = parseAppendOnlyEntries(content);
    assert.equal(entries.length, 3);
  });
});

describe('parseReferenceEntries', () => {
  it('returns empty array for content with no sections', async () => {
    const { parseReferenceEntries } = await import('../scripts/lib/index-utils.js');
    const result = parseReferenceEntries('No sections here\n');
    assert.deepEqual(result, []);
  });

  it('parses top-level bullets within ## sections', async () => {
    const { parseReferenceEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Profile

## Identity

- **Name:** Kevin Lee
  Additional detail here.
- **Age:** 30

## Goals

- **Learn Rust** by end of year
`;
    const entries = parseReferenceEntries(content);
    assert.ok(entries.length >= 3, `expected at least 3 entries, got ${entries.length}`);
  });

  it('extracts section name', async () => {
    const { parseReferenceEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Profile

## Identity

- **Name:** Kevin

## Goals

- **Goal:** Learn TypeScript
`;
    const entries = parseReferenceEntries(content);
    const identityEntry = entries.find(e => e.section === 'Identity');
    assert.ok(identityEntry, 'should find entry in Identity section');
    const goalsEntry = entries.find(e => e.section === 'Goals');
    assert.ok(goalsEntry, 'should find entry in Goals section');
  });

  it('extracts entity from **bold text**, normalized to lowercase-hyphenated', async () => {
    const { parseReferenceEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Profile

## Identity

- **Full Name:** Kevin Lee
`;
    const entries = parseReferenceEntries(content);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entity, 'full-name');
  });

  it('includes indented child lines in the entry text', async () => {
    const { parseReferenceEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Knowledge

## Medical

- **Dr. Smith**
  - Specialty: PCP
  - Phone: 555-1234
`;
    const entries = parseReferenceEntries(content);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].text.includes('Specialty: PCP'));
    assert.ok(entries[0].text.includes('Phone: 555-1234'));
  });

  it('strips non-alphanumeric chars from entity (e.g. Dr. Smith → dr-smith)', async () => {
    const { parseReferenceEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Knowledge

## Medical

- **Dr. Smith**
  - Specialty: PCP
`;
    const entries = parseReferenceEntries(content);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entity, 'dr-smith');
  });

  it('skips entries with existing <!-- id: markers', async () => {
    const { parseReferenceEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Profile

## Identity

- **Name:** Kevin <!-- id:20250101-0000-mig01 -->
- **Age:** 30
`;
    const entries = parseReferenceEntries(content);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].text.includes('Age'));
  });

  it('returns lineIndex for each entry', async () => {
    const { parseReferenceEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Profile

## Identity

- **Name:** Kevin
- **Age:** 30
`;
    const entries = parseReferenceEntries(content);
    // lineIndex should be a non-negative integer
    for (const e of entries) {
      assert.ok(typeof e.lineIndex === 'number' && e.lineIndex >= 0, `lineIndex should be >= 0, got ${e.lineIndex}`);
    }
    // Second entry should have a higher lineIndex than first
    if (entries.length >= 2) {
      assert.ok(entries[1].lineIndex > entries[0].lineIndex);
    }
  });
});

describe('parseTaskEntries', () => {
  it('returns empty array for content with no sections', async () => {
    const { parseTaskEntries } = await import('../scripts/lib/index-utils.js');
    const result = parseTaskEntries('No sections here\n');
    assert.deepEqual(result, []);
  });

  it('parses checkbox lines within ## sections', async () => {
    const { parseTaskEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Tasks

## Work

- [ ] Ship the feature
- [x] Write tests
- [ ] Deploy to prod

## Personal

- [ ] Grocery shopping
`;
    const entries = parseTaskEntries(content);
    assert.equal(entries.length, 4);
  });

  it('extracts section name', async () => {
    const { parseTaskEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Tasks

## Work

- [ ] Ship feature

## Personal

- [ ] Buy groceries
`;
    const entries = parseTaskEntries(content);
    const workEntry = entries.find(e => e.section === 'Work');
    assert.ok(workEntry);
    const personalEntry = entries.find(e => e.section === 'Personal');
    assert.ok(personalEntry);
  });

  it('parses both unchecked and checked boxes', async () => {
    const { parseTaskEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Tasks

## Work

- [ ] Pending task
- [x] Done task
`;
    const entries = parseTaskEntries(content);
    assert.equal(entries.length, 2);
    assert.ok(entries[0].text.includes('Pending task'));
    assert.ok(entries[1].text.includes('Done task'));
  });

  it('skips entries with existing IDs', async () => {
    const { parseTaskEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Tasks

## Work

- [ ] Already indexed <!-- id:20250101-0000-mig01 -->
- [ ] New task
`;
    const entries = parseTaskEntries(content);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].text.includes('New task'));
  });

  it('returns lineIndex for each entry', async () => {
    const { parseTaskEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Tasks

## Work

- [ ] Task one
- [ ] Task two
`;
    const entries = parseTaskEntries(content);
    assert.equal(entries.length, 2);
    assert.ok(entries[1].lineIndex > entries[0].lineIndex);
  });

  it('captures indented sub-task continuation lines in entry text', async () => {
    const { parseTaskEntries } = await import('../scripts/lib/index-utils.js');
    const content = `# Tasks

## Work

- [ ] Ship feature
  - by Friday
  - needs review
- [ ] Write tests
`;
    const entries = parseTaskEntries(content);
    assert.equal(entries.length, 2);
    assert.ok(entries[0].text.includes('Ship feature'));
    assert.ok(entries[0].text.includes('by Friday'));
    assert.ok(entries[0].text.includes('needs review'));
    assert.ok(entries[1].text.includes('Write tests'));
    // Second task should not contain the first task's sub-items
    assert.ok(!entries[1].text.includes('by Friday'));
  });
});

describe('injectIdIntoLine', () => {
  it('appends <!-- id:<id> --> to a line', async () => {
    const { injectIdIntoLine } = await import('../scripts/lib/index-utils.js');
    const result = injectIdIntoLine('- [ ] Ship the feature', '20250101-0000-mig01');
    assert.equal(result, '- [ ] Ship the feature <!-- id:20250101-0000-mig01 -->');
  });

  it('preserves the original line content', async () => {
    const { injectIdIntoLine } = await import('../scripts/lib/index-utils.js');
    const original = '- **Name:** Kevin Lee';
    const result = injectIdIntoLine(original, 'some-id');
    assert.ok(result.startsWith(original));
  });
});

describe('injectIdBeforeBlock', () => {
  it('prepends <!-- id:<id> --> line before block', async () => {
    const { injectIdBeforeBlock } = await import('../scripts/lib/index-utils.js');
    const result = injectIdBeforeBlock('**2025-01-01**\nEntry text.', '20250101-0000-mig01');
    assert.equal(result, '<!-- id:20250101-0000-mig01 -->\n**2025-01-01**\nEntry text.');
  });
});

describe('injectIdsIntoFile', () => {
  it('returns same content when assignments is empty', async () => {
    const { injectIdsIntoFile } = await import('../scripts/lib/index-utils.js');
    const content = 'Line 0\nLine 1\nLine 2\n';
    assert.equal(injectIdsIntoFile(content, []), content);
  });

  it('injects inline ID onto the correct line', async () => {
    const { injectIdsIntoFile } = await import('../scripts/lib/index-utils.js');
    const content = '- [ ] Task one\n- [ ] Task two\n- [ ] Task three\n';
    const result = injectIdsIntoFile(content, [
      { lineIndex: 1, id: 'id-002', type: 'inline' },
    ]);
    const lines = result.split('\n');
    assert.ok(lines[1].includes('<!-- id:id-002 -->'));
    assert.ok(!lines[0].includes('<!-- id:'));
    assert.ok(!lines[2].includes('<!-- id:'));
  });

  it('injects block ID before the correct line', async () => {
    const { injectIdsIntoFile } = await import('../scripts/lib/index-utils.js');
    const content = '**2025-01-01**\nEntry.\n\n**2025-01-02**\nAnother.\n';
    const result = injectIdsIntoFile(content, [
      { lineIndex: 0, id: 'id-001', type: 'block' },
    ]);
    const lines = result.split('\n');
    assert.equal(lines[0], '<!-- id:id-001 -->');
    assert.equal(lines[1], '**2025-01-01**');
  });

  it('processes multiple assignments correctly in reverse order', async () => {
    const { injectIdsIntoFile } = await import('../scripts/lib/index-utils.js');
    const content = '- [ ] Task one\n- [ ] Task two\n- [ ] Task three\n';
    const result = injectIdsIntoFile(content, [
      { lineIndex: 0, id: 'id-001', type: 'inline' },
      { lineIndex: 2, id: 'id-003', type: 'inline' },
    ]);
    const lines = result.split('\n');
    assert.ok(lines[0].includes('<!-- id:id-001 -->'));
    assert.ok(!lines[1].includes('<!-- id:'));
    assert.ok(lines[2].includes('<!-- id:id-003 -->'));
  });

  it('correctly handles multiple block insertions', async () => {
    const { injectIdsIntoFile } = await import('../scripts/lib/index-utils.js');
    const content = '**2025-01-01**\nEntry one.\n\n**2025-01-02**\nEntry two.\n';
    const result = injectIdsIntoFile(content, [
      { lineIndex: 0, id: 'id-001', type: 'block' },
      { lineIndex: 3, id: 'id-002', type: 'block' },
    ]);
    assert.ok(result.includes('<!-- id:id-001 -->'));
    assert.ok(result.includes('<!-- id:id-002 -->'));
    // Both entries should be present
    assert.ok(result.includes('**2025-01-01**'));
    assert.ok(result.includes('**2025-01-02**'));
  });
});

describe('generateSkeletonIndex', () => {
  it('generates a markdown index with "# Index: <title>" heading', async () => {
    const { generateSkeletonIndex } = await import('../scripts/lib/index-utils.js');
    const entries = [
      { id: 'id-001', section: 'Identity', entity: 'name', text: '- **Name:** Kevin' },
    ];
    const resultProfile = generateSkeletonIndex('Profile', entries, 'fact');
    assert.ok(resultProfile.includes('# Index: Profile'), `expected "# Index: Profile" in: ${resultProfile}`);

    const taskEntries = [{ id: 'id-001', section: 'Work', text: '- [ ] Task' }];
    const resultTasks = generateSkeletonIndex('Tasks', taskEntries, 'entry');
    assert.ok(resultTasks.includes('# Index: Tasks'), `expected "# Index: Tasks" in: ${resultTasks}`);
  });

  it('fact level groups by section and uses list-item format with entity', async () => {
    const { generateSkeletonIndex } = await import('../scripts/lib/index-utils.js');
    const entries = [
      { id: 'id-001', section: 'Identity', entity: 'name', text: '- **Name:** Kevin' },
      { id: 'id-002', section: 'Identity', entity: 'age', text: '- **Age:** 30' },
      { id: 'id-003', section: 'Goals', entity: 'learn-rust', text: '- **Learn Rust**' },
    ];
    const result = generateSkeletonIndex('Profile', entries, 'fact');
    assert.ok(result.includes('## Identity'));
    assert.ok(result.includes('## Goals'));
    assert.ok(result.includes('- id: id-001'));
    assert.ok(result.includes('  entity: name'));
    assert.ok(result.includes('- id: id-003'));
    assert.ok(result.includes('  entity: learn-rust'));
  });

  it('fact level entries have enriched: false, domains: [], related: []', async () => {
    const { generateSkeletonIndex } = await import('../scripts/lib/index-utils.js');
    const entries = [
      { id: 'id-001', section: 'Identity', entity: 'name', text: '- **Name:** Kevin' },
    ];
    const result = generateSkeletonIndex('Profile', entries, 'fact');
    assert.ok(result.includes('  enriched: false'));
    assert.ok(result.includes('  domains: []'));
    assert.ok(result.includes('  related: []'));
  });

  it('entry level uses list-item format with summary, tags', async () => {
    const { generateSkeletonIndex } = await import('../scripts/lib/index-utils.js');
    const entries = [
      { id: 'id-001', text: '**2025-01-01**\nHad a great day.' },
      { id: 'id-002', text: '**2025-01-02**\nAnother day.' },
    ];
    const result = generateSkeletonIndex('Journal', entries, 'entry');
    assert.ok(result.includes('# Index: Journal'));
    assert.ok(result.includes('- id: id-001'));
    assert.ok(result.includes('- id: id-002'));
    assert.ok(result.includes('  tags: []'));
    assert.ok(result.includes('  summary: ~'));
  });

  it('entry level also has enriched: false, domains: [], related: []', async () => {
    const { generateSkeletonIndex } = await import('../scripts/lib/index-utils.js');
    const entries = [
      { id: 'id-001', text: '**2025-01-01**\nEntry.' },
    ];
    const result = generateSkeletonIndex('Journal', entries, 'entry');
    assert.ok(result.includes('  enriched: false'));
    assert.ok(result.includes('  domains: []'));
    assert.ok(result.includes('  related: []'));
  });
});

describe('generateManifest', () => {
  it('generates a manifest with "# Memory Manifest" heading', async () => {
    const { generateManifest } = await import('../scripts/lib/index-utils.js');
    const files = [
      { name: 'profile.md', path: 'profile.md', indexPath: 'profile.index.md', type: 'fact', entries: 5, sections: ['Identity', 'Goals'] },
    ];
    const result = generateManifest(files);
    assert.ok(result.startsWith('# Memory Manifest'), `expected "# Memory Manifest" heading, got: ${result.slice(0, 50)}`);
  });

  it('includes "Generated by Dream" and "Last updated" lines', async () => {
    const { generateManifest } = await import('../scripts/lib/index-utils.js');
    const files = [
      { name: 'profile.md', path: 'profile.md', indexPath: 'profile.index.md', type: 'fact', entries: 5 },
    ];
    const result = generateManifest(files);
    assert.ok(result.includes('Generated by Dream. Do not edit manually.'));
    assert.ok(result.includes('Last updated:'));
  });

  it('uses list-item format (- file: <name>) for file entries', async () => {
    const { generateManifest } = await import('../scripts/lib/index-utils.js');
    const files = [
      { name: 'profile.md', path: 'profile.md', indexPath: 'profile.index.md', type: 'fact', entries: 5, sections: ['Identity', 'Goals'] },
      { name: 'journal.md', path: 'journal.md', indexPath: 'journal.index.md', type: 'entry', entries: 12 },
    ];
    const result = generateManifest(files);
    assert.ok(result.includes('- file: profile.md'));
    assert.ok(result.includes('- file: journal.md'));
    assert.ok(result.includes('  path: profile.md'));
    assert.ok(result.includes('  index: profile.index.md'));
    assert.ok(result.includes('  index: journal.index.md'));
  });

  it('includes entry count for each file', async () => {
    const { generateManifest } = await import('../scripts/lib/index-utils.js');
    const files = [
      { name: 'tasks.md', path: 'tasks.md', indexPath: 'tasks.index.md', type: 'entry', entries: 7 },
    ];
    const result = generateManifest(files);
    assert.ok(result.includes('  entries: 7'));
  });

  it('includes type for each file', async () => {
    const { generateManifest } = await import('../scripts/lib/index-utils.js');
    const files = [
      { name: 'profile.md', path: 'profile.md', indexPath: 'profile.index.md', type: 'fact', entries: 3 },
    ];
    const result = generateManifest(files);
    assert.ok(result.includes('  type: fact'));
  });

  it('includes domains when provided', async () => {
    const { generateManifest } = await import('../scripts/lib/index-utils.js');
    const files = [
      { name: 'knowledge.md', path: 'knowledge.md', indexPath: 'knowledge.index.md', type: 'fact', entries: 8, domains: ['medical', 'finance'] },
    ];
    const result = generateManifest(files);
    assert.ok(result.includes('medical') && result.includes('finance'));
  });
});
