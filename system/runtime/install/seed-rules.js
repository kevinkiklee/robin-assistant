// seed-rules.js — idempotently install authored seed rules from
// system/cognition/skeleton/rules/ into the `rules` table.
//
// Authored seed rules:
//   - Are version-pinned in skeleton/. User edits them via the file;
//     the DB row reflects the current skeleton version.
//   - Are NOT retracted by corrections (not_retractable: true in frontmatter).
//   - Are identified by `meta.id` (stable slug), not the SurrealDB record id.
//
// Idempotency contract:
//   - First run: creates the rule with active=true.
//   - Re-run, same version: no write (nothing to do).
//   - Re-run, newer skeleton version: updates content + meta.version.
//   - Existing rule with SAME or NEWER version: not touched (user may have
//     edited the DB row; respect it unless the skeleton explicitly supersedes).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { surql } from 'surrealdb';
import { packageRootDir } from '../../config/data-store.js';

const SKELETON_RULES_DIR = join(packageRootDir(), 'system', 'cognition', 'skeleton', 'rules');

/**
 * Parse YAML-style frontmatter from a markdown file.
 * Returns { frontmatter: {}, body: '' }.
 * Only handles simple key: value pairs (no nested objects/arrays).
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  const fm = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (val === 'true') fm[key] = true;
    else if (val === 'false') fm[key] = false;
    else if (/^\d+$/.test(val)) fm[key] = Number(val);
    else fm[key] = val;
  }
  return { frontmatter: fm, body: match[2] };
}

/**
 * Load all *.md files from the skeleton rules directory.
 * Returns an array of { id, version, content, frontmatter } objects.
 * Skips files whose frontmatter is missing `id` (not a seed rule).
 */
async function loadSkeletonRules(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const rules = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const raw = await readFile(join(dir, name), 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    if (!frontmatter.id) continue;
    rules.push({
      id: frontmatter.id,
      version: typeof frontmatter.version === 'number' ? frontmatter.version : 1,
      content: body.trim(),
      frontmatter,
    });
  }
  return rules;
}

/**
 * Upsert one seed rule into the `rules` table, idempotently.
 *
 * Logic:
 *   1. SELECT existing rule WHERE meta.id = rule.id LIMIT 1.
 *   2. If none: CREATE.
 *   3. If found and existing version < skeleton version: UPDATE content + meta.version.
 *   4. If found and existing version >= skeleton version: no-op.
 *
 * Returns: { action: 'created'|'updated'|'skipped', id }
 */
async function upsertSeedRule(db, rule) {
  const [rows] = await db
    .query(surql`SELECT id, meta FROM rules WHERE meta.id = ${rule.id} LIMIT 1`)
    .collect();
  const existing = Array.isArray(rows) ? rows[0] : null;

  if (!existing) {
    // source_candidate is option<record<rule_candidates>>; omit rather than
    // set null — SurrealDB rejects a literal null for REFERENCE fields.
    const fields = {
      content: rule.content,
      kind: 'behavior',
      priority: 80,
      active: true,
      meta: {
        id: rule.id,
        version: rule.version,
        source: rule.frontmatter.source ?? 'skeleton',
        not_retractable: rule.frontmatter.not_retractable ?? false,
        skeleton_kind: rule.frontmatter.kind ?? 'authored_seed',
        created_at: rule.frontmatter.created_at ?? new Date().toISOString(),
      },
    };
    const [created] = await db.query(surql`CREATE rules CONTENT ${fields}`).collect();
    const row = Array.isArray(created) ? created[0] : created;
    return { action: 'created', id: row?.id };
  }

  const existingVersion = existing.meta?.version ?? 0;
  if (existingVersion < rule.version) {
    await db
      .query(
        surql`UPDATE ${existing.id} MERGE ${{
          content: rule.content,
          meta: {
            ...existing.meta,
            version: rule.version,
          },
        }}`,
      )
      .collect();
    return { action: 'updated', id: existing.id };
  }

  return { action: 'skipped', id: existing.id };
}

/**
 * Install all authored seed rules from skeleton/ into the DB.
 * Called from applyMigrations (install + upgrade paths) after migrations run.
 *
 * @param {object} db - Live SurrealDB client.
 * @param {object} [opts]
 * @param {string} [opts.dir] - Override skeleton rules dir (for testing).
 * @returns {Promise<Array<{id: string, action: string}>>}
 */
export async function seedRules(db, opts = {}) {
  const dir = opts.dir ?? SKELETON_RULES_DIR;
  const rules = await loadSkeletonRules(dir);
  const results = [];
  for (const rule of rules) {
    const result = await upsertSeedRule(db, rule);
    results.push({ ruleId: rule.id, ...result });
  }
  return results;
}

export { loadSkeletonRules, parseFrontmatter };
