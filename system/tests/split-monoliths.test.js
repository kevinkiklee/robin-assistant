import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSplit, repairCrossReferences } from '../scripts/split-monoliths.js';
import { parseHeadings, sectionSizes } from '../scripts/lib/memory-index.js';

function makeMonolith() {
  const root = mkdtempSync(join(tmpdir(), 'robin-split-'));
  const memDir = join(root, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'knowledge.md'), [
    '---',
    'description: monolith',
    '---',
    '# Knowledge',
    '',
    '## Locations',
    '',
    '- 123 Main St',
    '',
    '## Suggested fields',
    '',
    '- Address',
    '- Best time',
    '',
    '## Medical',
    '',
    '- Dr. A',
    '- Dr. B',
  ].join('\n') + '\n');
  return { root, memDir };
}

test('executeSplit emits one file per root and absorbs children into preceding root', () => {
  const { root, memDir } = makeMonolith();
  const filePath = join(memDir, 'knowledge.md');
  const content = readFileSync(filePath, 'utf-8');
  const headings = parseHeadings(content);

  // Decision: Locations=root, Suggested fields=child, Medical=root
  const decisions = headings.filter(h => h.level === 2).map(h => ({
    heading: h,
    role: h.title === 'Suggested fields' ? 'child' : 'root',
    ownSize: 5,
  }));

  const emitted = executeSplit(filePath, 'knowledge', decisions);

  assert.equal(emitted.length, 2);
  assert.ok(existsSync(join(memDir, 'knowledge/locations.md')));
  assert.ok(existsSync(join(memDir, 'knowledge/medical.md')));
  assert.equal(existsSync(join(memDir, 'knowledge/suggested-fields.md')), false);
  assert.equal(existsSync(filePath), false);

  const locations = readFileSync(join(memDir, 'knowledge/locations.md'), 'utf-8');
  assert.match(locations, /## Suggested fields/);
  assert.match(locations, /Best time/);
  // Frontmatter present
  assert.match(locations, /^---\ndescription:/);

  rmSync(root, { recursive: true, force: true });
});

test('executeSplit strips inline pointer IDs from emitted content', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-split-'));
  const memDir = join(root, 'memory');
  mkdirSync(memDir, { recursive: true });
  const filePath = join(memDir, 'knowledge.md');
  writeFileSync(filePath, [
    '# Knowledge',
    '',
    '## Locations',
    '',
    '- 123 Main St <!-- id:20260427-0000-mig001 -->',
    '- 456 Park Ave <!-- id:20260427-0000-mig002 -->',
  ].join('\n') + '\n');

  const headings = parseHeadings(readFileSync(filePath, 'utf-8'));
  const decisions = [{ heading: headings[0], role: 'root', ownSize: 3 }];
  executeSplit(filePath, 'knowledge', decisions);

  const out = readFileSync(join(memDir, 'knowledge/locations.md'), 'utf-8');
  assert.equal(out.includes('mig001'), false);
  assert.equal(out.includes('mig002'), false);
  rmSync(root, { recursive: true, force: true });
});

test('executeSplit disambiguates duplicate slugs from duplicate root titles', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-split-'));
  const memDir = join(root, 'memory');
  mkdirSync(memDir, { recursive: true });
  const filePath = join(memDir, 'profile.md');
  writeFileSync(filePath, [
    '# Profile',
    '',
    '## Identity',
    'first identity',
    '',
    '## Identity',
    'second identity',
  ].join('\n') + '\n');

  const headings = parseHeadings(readFileSync(filePath, 'utf-8'));
  // Both as roots — collision.
  const decisions = headings.filter(h => h.level === 2).map(h => ({ heading: h, role: 'root', ownSize: 2 }));
  executeSplit(filePath, 'profile', decisions);

  assert.ok(existsSync(join(memDir, 'profile/identity.md')));
  assert.ok(existsSync(join(memDir, 'profile/identity-2.md')));
  rmSync(root, { recursive: true, force: true });
});

test('repairCrossReferences rewrites markdown links across the memory tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-split-'));
  const memDir = join(root, 'memory');
  mkdirSync(join(memDir, 'profile'), { recursive: true });
  writeFileSync(join(memDir, 'inbox.md'), 'See [old](knowledge.md) for context.\n');
  writeFileSync(join(memDir, 'profile/identity.md'), 'Also [old](../knowledge.md) here.\n');

  const renames = new Map([['knowledge.md', 'knowledge/locations.md']]);
  repairCrossReferences(memDir, renames);

  const inbox = readFileSync(join(memDir, 'inbox.md'), 'utf-8');
  assert.equal(inbox, 'See [old](knowledge/locations.md) for context.\n');
  const identity = readFileSync(join(memDir, 'profile/identity.md'), 'utf-8');
  assert.equal(identity, 'Also [old](../knowledge/locations.md) here.\n');

  rmSync(root, { recursive: true, force: true });
});
