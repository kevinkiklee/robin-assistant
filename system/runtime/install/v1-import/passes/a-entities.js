// passes/a-entities.js — create entities from knowledge/** and profile/people/**.
//
// Each .md file produces at most one entity. Canonical name comes from the
// ENTITIES.md table (Pass 0) when available; otherwise from the file's first
// `# Heading` line; otherwise from the slug (basename without extension).

import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { parseFrontmatter } from '../parsers/frontmatter.js';
import { entityTypeForKnowledgePath } from '../taxonomy.js';
import { upsertEntity } from '../writers/entity-writer.js';

/**
 * Walk knowledge/** and profile/people/** and write entities.
 *
 * @returns {Promise<{ entitiesByPath: Map<string, object>, counts: object }>}
 *   `entitiesByPath`: relative path → entity row info (`{ id, name, type }`).
 *   `counts`: { created, merged, skipped, errors }.
 */
export async function passEntities({ memoryDir, canonical, db, sessionId, report }) {
  const counts = { created: 0, merged: 0, skipped: 0, errors: 0 };
  const entitiesByPath = new Map();

  const knowledgeDir = join(memoryDir, 'knowledge');
  for await (const filePath of walkMarkdown(knowledgeDir)) {
    const rel = relative(memoryDir, filePath);
    try {
      const result = await emitEntityFor({
        filePath,
        rel,
        ledgerSrc: rel,
        type: entityTypeForKnowledgePath(relative(knowledgeDir, filePath)),
        canonical,
        db,
        sessionId,
      });
      if (result) {
        counts[result.action] = (counts[result.action] ?? 0) + 1;
        entitiesByPath.set(rel, result);
      }
    } catch (e) {
      counts.errors++;
      report.errors.push({ pass: 'A', file: rel, message: e.message });
    }
  }

  const peopleDir = join(memoryDir, 'profile', 'people');
  for await (const filePath of walkMarkdown(peopleDir)) {
    const rel = relative(memoryDir, filePath);
    if (rel.endsWith('/INDEX.md')) continue;
    try {
      const result = await emitEntityFor({
        filePath,
        rel,
        ledgerSrc: rel,
        type: 'person',
        canonical,
        db,
        sessionId,
      });
      if (result) {
        counts[result.action] = (counts[result.action] ?? 0) + 1;
        entitiesByPath.set(rel, result);
      }
    } catch (e) {
      counts.errors++;
      report.errors.push({ pass: 'A', file: rel, message: e.message });
    }
  }

  return { entitiesByPath, counts };
}

async function emitEntityFor({ filePath, rel, ledgerSrc, type, canonical, db, sessionId }) {
  const raw = await readFile(filePath, 'utf8');
  const { body } = parseFrontmatter(raw);

  // Skip INDEX-only docs (they're catalogues, not entity bodies).
  if (basename(filePath) === 'INDEX.md') return null;

  const canonEntry = canonical.byPath.get(rel);
  let name;
  let aliases = [];
  if (canonEntry) {
    name = canonEntry.canonical_name;
    aliases = canonEntry.aliases;
  } else {
    const h1Match = body.match(/^#\s+(.+)$/m);
    name = h1Match ? h1Match[1].trim() : slugify(basename(filePath, '.md'));
  }

  const res = await upsertEntity(db, {
    name,
    type,
    aliases,
    sourcePath: ledgerSrc,
    sessionId,
  });
  return { id: res.id, name, type, action: res.action };
}

async function* walkMarkdown(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkMarkdown(p);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      yield p;
    }
  }
}

function slugify(s) {
  return String(s).replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-');
}
