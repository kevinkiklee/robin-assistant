import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { resolveUserDataDir } from '../../lib/paths.ts';
import type { LoadedSkill, Skill, SkillRoot, SkillSource } from './types.ts';

// Re-export the public types so consumers (tests, the MCP server) have one import site.
export type { LoadedSkill, Skill, SkillRoot, SkillSource } from './types.ts';

const SKILL_FILE = 'SKILL.md';
// Skill identity = directory name. Constrained to kebab-case so it's safe to use
// as a `get` key and clean to display. Anything else is skipped (with a warning).
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The shipped system-skill root, resolved relative to THIS module so it works in
 * both layouts: `system/skills/_runtime/loader.ts` → `system/skills/builtin`, and
 * the compiled `dist/skills/_runtime/loader.js` → `dist/skills/builtin` (the build
 * mirrors the markdown there). The user root is gitignored personal skills.
 */
export function defaultSkillRoots(userDataDir: string = resolveUserDataDir()): SkillRoot[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    { dir: join(here, '..', 'builtin'), source: 'system' },
    { dir: join(userDataDir, 'extensions', 'skills'), source: 'user' },
  ];
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.filter((f) => f !== SKILL_FILE).sort();
}

function parseSkill(dir: string, name: string, source: SkillSource): Skill {
  const base: Skill = { name, description: '', source, dir, files: [], valid: false };
  const skillPath = join(dir, SKILL_FILE);
  if (!existsSync(skillPath)) return { ...base, error: `missing ${SKILL_FILE}` };
  try {
    const fm = matter(readFileSync(skillPath, 'utf8')).data as { description?: unknown };
    const description = typeof fm.description === 'string' ? fm.description.trim() : '';
    const files = listFiles(dir);
    if (!description) return { ...base, files, error: 'missing frontmatter `description`' };
    return { name, description, source, dir, files, valid: true };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Scan all roots and return the merged catalog. `user` skills shadow `system`
 * skills with the same directory name. Invalid skills (bad/missing frontmatter)
 * are included with `valid: false` so authors can see why; only directories whose
 * name isn't kebab-case are skipped outright.
 */
export function listSkills(roots: SkillRoot[]): Skill[] {
  const byName = new Map<string, Skill>();
  // System first, then user, so user overwrites system on a name collision.
  const ordered = [...roots].sort((a, b) =>
    a.source === b.source ? 0 : a.source === 'system' ? -1 : 1,
  );
  for (const root of ordered) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir)) {
      if (entry.startsWith('_') || entry.startsWith('.')) continue;
      const full = join(root.dir, entry);
      if (!statSync(full).isDirectory()) continue;
      if (!NAME_RE.test(entry)) {
        // biome-ignore lint/suspicious/noConsole: surface skipped skills to the operator
        console.error(`skills loader: skipping non-kebab-case directory '${entry}' in ${root.dir}`);
        continue;
      }
      byName.set(entry, parseSkill(full, entry, root.source));
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load one valid skill's full body + metadata. `name` is resolved ONLY against the
 * scanned catalog — never path-joined into the filesystem — so a malicious name
 * like `../../secrets` cannot read arbitrary files (it simply won't match). Returns
 * null for unknown or invalid skills.
 */
export function readSkill(roots: SkillRoot[], name: string): LoadedSkill | null {
  const skill = listSkills(roots).find((s) => s.name === name && s.valid);
  if (!skill) return null;
  const body = matter(readFileSync(join(skill.dir, SKILL_FILE), 'utf8')).content.trim();
  return { ...skill, body };
}
