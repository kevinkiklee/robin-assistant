// passes/0-entities-md.js — read ENTITIES.md into the in-memory canonical-name
// table that subsequent passes consult before creating entities.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEntitiesMd } from '../parsers/entities-md.js';

/**
 * Build a CanonicalNameTable from `<memoryDir>/ENTITIES.md`. Returns an empty
 * table if the file is missing.
 *
 * The table is keyed two ways:
 *   - by source_path: lookup canonical/aliases when creating an entity for a
 *     specific knowledge/profile file.
 *   - by alias (lowercased): lookup canonical name when an arbitrary v1 string
 *     references the entity (e.g. inside LINKS.md, or for future fuzzy work).
 */
export async function buildCanonicalNameTable(memoryDir) {
  const path = join(memoryDir, 'ENTITIES.md');
  if (!existsSync(path)) {
    return { byPath: new Map(), byAlias: new Map(), entries: [] };
  }
  const body = await readFile(path, 'utf8');
  const entries = parseEntitiesMd(body);
  const byPath = new Map();
  const byAlias = new Map();
  for (const e of entries) {
    byPath.set(e.source_path, e);
    byAlias.set(e.canonical_name.toLowerCase(), e);
    for (const a of e.aliases) byAlias.set(a.toLowerCase(), e);
  }
  return { byPath, byAlias, entries };
}
