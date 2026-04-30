// Migration 0017: add per-sub-tree `decay` frontmatter to memory files.
//
// For each *.md under user-data/memory/ that lacks a `decay` field, we
// compute the default decay class using the same table used by lint-memory's
// staleness check (system/scripts/lib/decay.js → defaultDecayFor).
//
// Files with no frontmatter block at all are skipped with a warning — the
// same behaviour as migration 0016.
//
// Atomic writes, idempotent, crash-safe (same pattern as 0016).
//
// Reversible: strip the `decay:` lines. The values are deterministic and
// can be re-derived from defaultDecayFor().

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from '../scripts/lib/memory-index.js';
import { defaultDecayFor } from '../scripts/lib/decay.js';

export const id = '0017-add-decay-defaults';
export const description =
  'Add per-sub-tree decay frontmatter field to memory files lacking it (idempotent).';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function* walkMd(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkMd(full);
    } else if (name.endsWith('.md') && !name.endsWith('.tmp')) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export async function up({ workspaceDir }) {
  const memDir = join(workspaceDir, 'user-data', 'memory');
  if (!existsSync(memDir)) {
    console.log(`[${id}] user-data/memory not found — no-op`);
    return;
  }

  let stamped = 0;
  let skipped = 0;
  let noFm = 0;

  for (const filePath of walkMd(memDir)) {
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    // Skip files with no frontmatter block.
    if (Object.keys(frontmatter).length === 0 && !content.startsWith('---')) {
      console.log(`[${id}] SKIP (no frontmatter): ${relative(memDir, filePath)}`);
      noFm++;
      continue;
    }

    // Already has decay — idempotent.
    if (frontmatter.decay) {
      skipped++;
      continue;
    }

    // Compute default decay for this path.
    const relPath = relative(memDir, filePath).replace(/\\/g, '/');
    const decayClass = defaultDecayFor(relPath);

    // Build updated frontmatter preserving existing keys, appending decay.
    const newFm = { ...frontmatter, decay: decayClass };
    const updated = stringifyFrontmatter(newFm, body);

    // Atomic write.
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, updated, 'utf-8');
    renameSync(tmp, filePath);

    console.log(`[${id}] set decay: ${decayClass} → ${relative(memDir, filePath)}`);
    stamped++;
  }

  console.log(
    `[${id}] done — stamped: ${stamped}, already had decay: ${skipped}, no-frontmatter skip: ${noFm}`,
  );
}
