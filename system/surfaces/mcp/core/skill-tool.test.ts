import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SkillRoot } from '../../../skills/_runtime/loader.ts';
import { runSkillTool, skillCatalogDescription } from './skill-tool.ts';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'robin-skilltool-'));
}
function writeSkill(
  dir: string,
  name: string,
  frontmatter: string | null,
  body = 'instructions',
): void {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  const fm = frontmatter === null ? '' : `---\n${frontmatter}\n---\n`;
  writeFileSync(join(d, 'SKILL.md'), `${fm}\n${body}`);
}
function roots(sys: string, usr: string): SkillRoot[] {
  return [
    { dir: sys, source: 'system' },
    { dir: usr, source: 'user' },
  ];
}

test('skillCatalogDescription: lists valid skills, excludes invalid', () => {
  const sys = root();
  const usr = root();
  writeSkill(sys, 'web-research', 'name: web-research\ndescription: research with citations');
  writeSkill(sys, 'broken', 'name: broken'); // invalid (no description)
  const desc = skillCatalogDescription(roots(sys, usr));
  assert.match(desc, /web-research/);
  assert.match(desc, /research with citations/);
  assert.doesNotMatch(desc, /broken/, 'invalid skills must not appear in the catalog description');
});

test('skillCatalogDescription: empty catalog still produces usable text', () => {
  const desc = skillCatalogDescription(roots(root(), root()));
  assert.ok(desc.length > 0);
  assert.match(desc, /skill/i);
});

test('runSkillTool: get by name returns body + files', () => {
  const sys = root();
  const usr = root();
  writeSkill(
    usr,
    'color-grading',
    'name: color-grading\ndescription: grade photos',
    '# Grade\nstep',
  );
  const res = runSkillTool(roots(sys, usr), { name: 'color-grading' }) as {
    name: string;
    body: string;
    source: string;
  };
  assert.equal(res.name, 'color-grading');
  assert.equal(res.source, 'user');
  assert.match(res.body, /Grade/);
});

test('runSkillTool: unknown name returns error + available names', () => {
  const sys = root();
  const usr = root();
  writeSkill(sys, 'web-research', 'name: web-research\ndescription: y');
  const res = runSkillTool(roots(sys, usr), { name: 'nope' }) as {
    error: string;
    available: string[];
  };
  assert.match(res.error, /unknown skill/);
  assert.deepEqual(res.available, ['web-research']);
});

test('runSkillTool: action=list returns all including invalid', () => {
  const sys = root();
  const usr = root();
  writeSkill(sys, 'web-research', 'name: web-research\ndescription: y');
  writeSkill(sys, 'broken', 'name: broken'); // invalid
  const res = runSkillTool(roots(sys, usr), { action: 'list' }) as {
    skills: Array<{ name: string; valid: boolean }>;
  };
  const names = res.skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['broken', 'web-research']);
  assert.equal(res.skills.find((s) => s.name === 'broken')?.valid, false);
});

test('runSkillTool: no args returns the valid-skill catalog (metadata only)', () => {
  const sys = root();
  const usr = root();
  writeSkill(sys, 'web-research', 'name: web-research\ndescription: y', '# big body');
  writeSkill(sys, 'broken', 'name: broken'); // invalid
  const res = runSkillTool(roots(sys, usr), {}) as {
    skills: Array<{ name: string; description: string; body?: string }>;
  };
  assert.deepEqual(
    res.skills.map((s) => s.name),
    ['web-research'],
  );
  assert.equal(res.skills[0].body, undefined, 'catalog is metadata only, no body');
});
