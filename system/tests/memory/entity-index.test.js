// system/tests/entity-index.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectEntities,
  renderEntitiesMarkdown,
  writeEntitiesAtomic,
  readEntities,
  detectUserEdit,
} from '../../scripts/memory/lib/entity-index.js';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'entity-index-'));
  const mem = join(ws, 'user-data/memory');
  mkdirSync(join(mem, 'profile'), { recursive: true });
  mkdirSync(join(mem, 'knowledge/finance'), { recursive: true });
  mkdirSync(join(ws, 'user-data/runtime/state'), { recursive: true });
  return { ws, mem };
}

describe('entity-index', () => {
  it('collectEntities picks up files with type:entity', () => {
    const { ws, mem } = setup();
    writeFileSync(join(mem, 'knowledge/finance/marcus.md'),
      '---\ntype: entity\ndescription: Marcus HYSA\naliases: [Marcus, GS HYSA]\n---\n# Marcus HYSA\n');
    const entities = collectEntities(ws);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].name, 'Marcus HYSA');
    assert.deepEqual(entities[0].aliases, ['Marcus', 'GS HYSA']);
    assert.equal(entities[0].file, 'knowledge/finance/marcus.md');
  });

  it('collectEntities picks up files with aliases: but no type:entity', () => {
    const { ws, mem } = setup();
    writeFileSync(join(mem, 'profile/dentist.md'),
      '---\ndescription: dentist\naliases: [Dr. Park]\n---\n# Dr. Park\n');
    const entities = collectEntities(ws);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].name, 'Dr. Park');
  });

  it('renderEntitiesMarkdown produces header + DO NOT EDIT marker + rows', () => {
    const md = renderEntitiesMarkdown([
      { name: 'Dr. Park', aliases: ['Park'], file: 'profile/dentist.md', section: null },
    ]);
    assert.ok(md.includes('---'));
    assert.ok(md.includes('# Entities'));
    assert.ok(md.includes('DO NOT EDIT'));
    assert.ok(md.includes('Dr. Park (Park) — profile/dentist.md'));
  });

  it('writeEntitiesAtomic + readEntities round-trip', () => {
    const { ws } = setup();
    writeEntitiesAtomic(ws, [{ name: 'X', aliases: [], file: 'a.md', section: null }]);
    const file = join(ws, 'user-data/memory/ENTITIES.md');
    assert.ok(existsSync(file));
    const data = readEntities(ws);
    assert.equal(data.entities.length, 1);
    assert.equal(data.entities[0].name, 'X');
  });

  it('detectUserEdit returns true when content hash differs from stored', () => {
    const { ws } = setup();
    writeEntitiesAtomic(ws, [{ name: 'X', aliases: [], file: 'a.md', section: null }]);
    const file = join(ws, 'user-data/memory/ENTITIES.md');
    const orig = readFileSync(file, 'utf8');
    writeFileSync(file, orig + '\n- Y (manual) — b.md\n');
    assert.equal(detectUserEdit(ws), true);
  });

  it('detectUserEdit returns false for unedited file', () => {
    const { ws } = setup();
    writeEntitiesAtomic(ws, [{ name: 'X', aliases: [], file: 'a.md', section: null }]);
    assert.equal(detectUserEdit(ws), false);
  });

  it('writeEntitiesAtomic splits hot/extended at cap', () => {
    const { ws } = setup();
    const many = [];
    for (let i = 0; i < 200; i++) many.push({ name: `E${i}`, aliases: [], file: `f${i}.md`, section: null });
    writeEntitiesAtomic(ws, many, { hotCap: 150 });
    const hot = readFileSync(join(ws, 'user-data/memory/ENTITIES.md'), 'utf8');
    const ext = readFileSync(join(ws, 'user-data/memory/ENTITIES-extended.md'), 'utf8');
    const hotRows = hot.split('\n').filter((l) => l.startsWith('- ')).length;
    const extRows = ext.split('\n').filter((l) => l.startsWith('- ')).length;
    assert.equal(hotRows, 150);
    assert.equal(extRows, 50);
  });

  it('collectEntities prefers H1 heading when description has no em-dash', () => {
    const { ws, mem } = setup();
    // description has no em-dash; H1 is the canonical name
    writeFileSync(join(mem, 'profile/x.md'),
      '---\ntype: entity\ndescription: bare label without em-dash\n---\n# Canonical Name\n');
    const entities = collectEntities(ws);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].name, 'Canonical Name');
  });

  it('collectEntities falls back to deriveName when no H1 heading', () => {
    const { ws, mem } = setup();
    // No H1 at all; description has em-dash → derive from prefix
    writeFileSync(join(mem, 'profile/x.md'),
      '---\ntype: entity\ndescription: From Description — extra context\n---\nbody without h1\n');
    const entities = collectEntities(ws);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].name, 'From Description');
  });

  it('collectEntities skips symlinks under user-data/memory/', async () => {
    const { ws, mem } = setup();
    const { symlinkSync } = await import('node:fs');
    const target = join(ws, 'outside.md');
    writeFileSync(target,
      '---\ntype: entity\naliases: [Outside]\n---\n# Should Not Be Indexed\n');
    symlinkSync(target, join(mem, 'profile/leak.md'));
    const entities = collectEntities(ws);
    assert.ok(!entities.some((e) => e.name === 'Should Not Be Indexed'));
  });
});
