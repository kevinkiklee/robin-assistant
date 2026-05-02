// system/tests/recall.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recall } from '../../scripts/memory/lib/recall.js';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'recall-'));
  const mem = join(ws, 'user-data/memory');
  mkdirSync(join(mem, 'profile'), { recursive: true });
  mkdirSync(join(mem, 'knowledge/medical'), { recursive: true });
  writeFileSync(join(mem, 'profile/people.md'), '---\ntype: entity\n---\n## Dr. Park\nDentist, JC.\n');
  writeFileSync(join(mem, 'knowledge/medical/providers.md'), '---\nlast_verified: 2026-01\n---\nDr. Park: appointment 2026-01.\n');
  return ws;
}

describe('recall', () => {
  it('returns hits across multiple files', () => {
    const ws = setup();
    const r = recall(ws, ['Dr. Park']);
    assert.ok(r.hits.length >= 2);
    assert.ok(r.hits.some((h) => h.file.endsWith('profile/people.md')));
    assert.ok(r.hits.some((h) => h.file.endsWith('knowledge/medical/providers.md')));
  });

  it('extracts last_verified from frontmatter when present', () => {
    const ws = setup();
    const r = recall(ws, ['Dr. Park']);
    const hit = r.hits.find((h) => h.file.endsWith('providers.md'));
    assert.equal(hit.last_verified, '2026-01');
  });

  it('caps to top-N hits', () => {
    const ws = setup();
    const mem = join(ws, 'user-data/memory');
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(mem, `dup-${i}.md`), `---\n---\nDr. Park noted on row ${i}.\n`);
    }
    const r = recall(ws, ['Dr. Park'], { topN: 5 });
    assert.equal(r.hits.length, 5);
    assert.equal(r.truncated, true);
  });

  it('multi-pattern dedup', () => {
    const ws = setup();
    const r = recall(ws, ['Dr. Park', 'Park']);
    const lines = new Set(r.hits.map((h) => `${h.file}:${h.line}`));
    assert.equal(lines.size, r.hits.length);
  });

  it('returns empty hits + truncated=false on no match', () => {
    const ws = setup();
    const r = recall(ws, ['Nonexistent Entity']);
    assert.deepEqual(r.hits, []);
    assert.equal(r.truncated, false);
  });

  it('skips files outside user-data/memory', () => {
    const ws = setup();
    mkdirSync(join(ws, 'system'), { recursive: true });
    writeFileSync(join(ws, 'system/elsewhere.md'), 'Dr. Park not relevant.\n');
    const r = recall(ws, ['Dr. Park']);
    assert.ok(!r.hits.some((h) => h.file.includes('system/')));
  });

  it('returns empty hits on empty patterns array (does not match everything)', () => {
    const ws = setup();
    const r = recall(ws, []);
    assert.deepEqual(r.hits, []);
    assert.equal(r.truncated, false);
  });

  it('skips symlinks to prevent memDir escape and cycles', async () => {
    const ws = setup();
    const { symlinkSync } = await import('node:fs');
    const target = join(ws, 'outside.md');
    writeFileSync(target, 'Dr. Park leaked from outside.\n');
    symlinkSync(target, join(ws, 'user-data/memory/leak.md'));
    const r = recall(ws, ['Dr. Park']);
    assert.ok(!r.hits.some((h) => h.file.endsWith('leak.md')));
  });
});
