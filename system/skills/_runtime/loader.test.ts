import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { listSkills, readSkill, type SkillRoot } from './loader.ts';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'robin-skills-'));
}

function writeSkill(
  root: string,
  name: string,
  opts: { frontmatter?: string | null; body?: string; files?: Record<string, string> } = {},
): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const { frontmatter, body = 'body text', files = {} } = opts;
  const fm = frontmatter === null ? '' : `---\n${frontmatter ?? ''}\n---\n`;
  writeFileSync(join(dir, 'SKILL.md'), `${fm}\n${body}`);
  for (const [rel, content] of Object.entries(files)) {
    const fp = join(dir, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
  }
}

function roots(systemDir: string, userDir: string): SkillRoot[] {
  return [
    { dir: systemDir, source: 'system' },
    { dir: userDir, source: 'user' },
  ];
}

test('listSkills: merges system + user catalogs', () => {
  const sys = tmpRoot();
  const usr = tmpRoot();
  writeSkill(sys, 'web-research', {
    frontmatter: 'name: web-research\ndescription: research things',
  });
  writeSkill(usr, 'color-grading', {
    frontmatter: 'name: color-grading\ndescription: grade photos',
  });

  const skills = listSkills(roots(sys, usr));
  const byName = new Map(skills.map((s) => [s.name, s]));
  assert.equal(skills.length, 2);
  assert.equal(byName.get('web-research')?.source, 'system');
  assert.equal(byName.get('color-grading')?.source, 'user');
  assert.ok(byName.get('web-research')?.valid);
});

test('listSkills: user shadows system on same name', () => {
  const sys = tmpRoot();
  const usr = tmpRoot();
  writeSkill(sys, 'web-research', {
    frontmatter: 'name: web-research\ndescription: SYSTEM version',
  });
  writeSkill(usr, 'web-research', { frontmatter: 'name: web-research\ndescription: USER version' });

  const skills = listSkills(roots(sys, usr));
  assert.equal(skills.length, 1, 'collision should collapse to one entry');
  assert.equal(skills[0].source, 'user');
  assert.equal(skills[0].description, 'USER version');
});

test('listSkills: malformed skill is surfaced as invalid, not dropped', () => {
  const sys = tmpRoot();
  const usr = tmpRoot();
  // missing description
  writeSkill(sys, 'broken', { frontmatter: 'name: broken' });
  // no frontmatter at all
  writeSkill(sys, 'nofm', { frontmatter: null, body: 'just text' });

  const skills = listSkills(roots(sys, usr));
  const broken = skills.find((s) => s.name === 'broken');
  const nofm = skills.find((s) => s.name === 'nofm');
  assert.ok(broken && broken.valid === false, 'broken skill present and invalid');
  assert.ok(broken?.error, 'invalid skill carries an error message');
  assert.ok(nofm && nofm.valid === false, 'no-frontmatter skill present and invalid');
});

test('listSkills: skips directories with non-kebab-case names', () => {
  const sys = tmpRoot();
  const usr = tmpRoot();
  writeSkill(sys, 'Bad Name', { frontmatter: 'name: x\ndescription: y' });
  writeSkill(sys, 'UPPER', { frontmatter: 'name: x\ndescription: y' });
  writeSkill(sys, 'ok-name', { frontmatter: 'name: ok-name\ndescription: y' });

  const skills = listSkills(roots(sys, usr));
  assert.deepEqual(
    skills.map((s) => s.name),
    ['ok-name'],
  );
});

test('listSkills: ignores _-prefixed and hidden dirs and missing roots', () => {
  const sys = tmpRoot();
  const usr = tmpRoot();
  writeSkill(sys, '_shared', { frontmatter: 'name: _shared\ndescription: y' });
  writeSkill(sys, 'real', { frontmatter: 'name: real\ndescription: y' });
  const skills = listSkills([
    { dir: sys, source: 'system' },
    { dir: join(usr, 'does-not-exist'), source: 'user' },
  ]);
  assert.deepEqual(
    skills.map((s) => s.name),
    ['real'],
  );
});

test('readSkill: returns body + recursive file list (excluding SKILL.md)', () => {
  const sys = tmpRoot();
  const usr = tmpRoot();
  writeSkill(usr, 'color-grading', {
    frontmatter: 'name: color-grading\ndescription: grade photos',
    body: '# How to grade\nstep one',
    files: { 'reference/luts.md': 'lut notes', 'scripts/apply.py': 'print(1)' },
  });

  const loaded = readSkill(roots(sys, usr), 'color-grading');
  assert.ok(loaded);
  assert.equal(loaded?.source, 'user');
  assert.match(loaded?.body ?? '', /How to grade/);
  assert.deepEqual([...(loaded?.files ?? [])].sort(), ['reference/luts.md', 'scripts/apply.py']);
});

test('readSkill: unknown name returns null', () => {
  const sys = tmpRoot();
  const usr = tmpRoot();
  writeSkill(sys, 'real', { frontmatter: 'name: real\ndescription: y' });
  assert.equal(readSkill(roots(sys, usr), 'nope'), null);
});

test('readSkill: rejects path traversal (resolves only against the catalog)', () => {
  const sys = tmpRoot();
  const usr = tmpRoot();
  writeSkill(sys, 'real', { frontmatter: 'name: real\ndescription: y' });
  // Any attempt to escape via name must not read arbitrary files.
  assert.equal(readSkill(roots(sys, usr), '../../../../etc/passwd'), null);
  assert.equal(readSkill(roots(sys, usr), '..'), null);
});

test('listSkills: directory name is authoritative even if frontmatter name differs', () => {
  const sys = tmpRoot();
  const usr = tmpRoot();
  writeSkill(sys, 'dir-name', {
    frontmatter: 'name: totally-different\ndescription: y',
  });
  const skills = listSkills(roots(sys, usr));
  assert.equal(skills[0].name, 'dir-name', 'catalog name comes from the directory');
  // and get() works by the directory name
  assert.ok(readSkill(roots(sys, usr), 'dir-name'));
  assert.equal(readSkill(roots(sys, usr), 'totally-different'), null);
});
