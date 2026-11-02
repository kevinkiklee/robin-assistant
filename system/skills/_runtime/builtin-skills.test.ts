import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listSkills, readSkill } from './loader.ts';

// Guards the shipped system skills: each must parse, be valid, carry a real
// description, and load. Catches a broken frontmatter edit before it ships.
const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'builtin');
const ROOTS = [{ dir: BUILTIN, source: 'system' as const }];
const EXPECTED = ['memory-curation', 'skill-authoring', 'web-research'];

test('seeded system skills: all present and valid', () => {
  const skills = listSkills(ROOTS);
  const byName = new Map(skills.map((s) => [s.name, s]));
  for (const name of EXPECTED) {
    const s = byName.get(name);
    assert.ok(s, `${name} should be present`);
    assert.equal(s?.valid, true, `${name} should be valid: ${s?.error ?? ''}`);
    assert.ok((s?.description.length ?? 0) > 10, `${name} needs a real description`);
  }
  // No invalid shipped skills.
  assert.deepEqual(
    skills.filter((s) => !s.valid).map((s) => s.name),
    [],
    'no shipped skill should be invalid',
  );
});

test('seeded system skills: each loads a non-empty body', () => {
  for (const name of EXPECTED) {
    const loaded = readSkill(ROOTS, name);
    assert.ok(loaded, `${name} should load`);
    assert.ok((loaded?.body.length ?? 0) > 100, `${name} body should be substantive`);
  }
});
