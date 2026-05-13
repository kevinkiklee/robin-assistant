import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDatedEntries } from '../../../../runtime/install/v1-import/parsers/dated-entries.js';

test('parseDatedEntries: splits on ## YYYY-MM-DD headers', () => {
  const src = [
    '# Journal',
    '',
    '## 2026-04-30',
    '',
    '- bullet one',
    '- bullet two',
    '',
    '## 2026-05-01',
    '',
    '- bullet three',
  ].join('\n');
  const rows = parseDatedEntries(src);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date.toISOString().slice(0, 10), '2026-04-30');
  assert.match(rows[0].content, /bullet one[\s\S]+bullet two/);
  assert.equal(rows[0].title, null);
  assert.equal(rows[1].date.toISOString().slice(0, 10), '2026-05-01');
  assert.match(rows[1].content, /bullet three/);
});

test('parseDatedEntries: parses ### YYYY-MM-DD — Title sections (corrections.md shape)', () => {
  const src = [
    '# Corrections',
    '',
    '### 2026-05-08 — A specific lesson',
    '',
    'Body of the correction.',
    '',
    '### 2026-04-27 — Another lesson',
    '',
    'Second body.',
  ].join('\n');
  const rows = parseDatedEntries(src);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'A specific lesson');
  assert.match(rows[0].content, /Body of the correction/);
  assert.equal(rows[1].title, 'Another lesson');
});

test('parseDatedEntries: empty sections are skipped', () => {
  const src = '## 2026-04-30\n\n## 2026-05-01\n\n- something';
  const rows = parseDatedEntries(src);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date.toISOString().slice(0, 10), '2026-05-01');
});

test('parseDatedEntries: returns midnight-UTC dates that are stable across runs', () => {
  const a = parseDatedEntries('## 2026-04-30\n- x');
  const b = parseDatedEntries('## 2026-04-30\n- x');
  assert.equal(a[0].date.getTime(), b[0].date.getTime());
  assert.equal(a[0].date.getUTCHours(), 0);
  assert.equal(a[0].date.getUTCMinutes(), 0);
});

test('parseDatedEntries: returns empty array when no headers match', () => {
  assert.deepEqual(parseDatedEntries('# No dated content here\n\n- bullet'), []);
});

test('parseDatedEntries: handles ## YYYY-MM-DD HH:MM headers (inbox.md shape)', () => {
  const src = [
    '# Inbox',
    '',
    '## 2026-05-07 21:00',
    '',
    '[feedback] first entry body',
    '',
    '## 2026-05-08 00:59',
    '',
    '[fact] second entry body',
    '- nested bullet',
  ].join('\n');
  const rows = parseDatedEntries(src);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date.toISOString().slice(0, 10), '2026-05-07');
  assert.equal(rows[0].title, '21:00');
  assert.match(rows[0].content, /first entry body/);
  assert.equal(rows[1].date.toISOString().slice(0, 10), '2026-05-08');
  assert.equal(rows[1].title, '00:59');
  assert.match(rows[1].content, /nested bullet/);
});

test('parseDatedEntries: handles ## [YYYY-MM-DD] headers (log.md shape)', () => {
  const src = [
    '# Log',
    '',
    '## [2026-04-28] lint | all | issues: 6',
    '',
    '- Contradictions: 0',
    '- Dead links: 0',
    '',
    '## [2026-05-04] artifacts-input audit | all | touched: 2 files',
    '',
    '- Validated 96 files',
  ].join('\n');
  const rows = parseDatedEntries(src);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date.toISOString().slice(0, 10), '2026-04-28');
  assert.equal(rows[0].title, 'lint | all | issues: 6');
  assert.match(rows[0].content, /Contradictions: 0/);
  assert.equal(rows[1].date.toISOString().slice(0, 10), '2026-05-04');
  assert.equal(rows[1].title, 'artifacts-input audit | all | touched: 2 files');
});

test('parseDatedEntries: many same-day inbox entries each become a separate row', () => {
  const sections = [];
  for (let i = 0; i < 10; i++) {
    const hh = String(i).padStart(2, '0');
    sections.push(`## 2026-05-08 ${hh}:00\n\nbody-${i}`);
  }
  const rows = parseDatedEntries(sections.join('\n\n'));
  assert.equal(rows.length, 10);
  // each has a unique line number; titles include the time-of-day
  const titles = rows.map((r) => r.title);
  assert.equal(new Set(titles).size, 10);
});
