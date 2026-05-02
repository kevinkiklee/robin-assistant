// Migration 0016: backfill `last_verified` frontmatter field on memory files.
//
// For each *.md under user-data/memory/ that lacks a `last_verified` field,
// we infer the date from git history (most-recent add/modify commit that
// touches the file). If git can't provide a date (file not tracked, git
// unavailable, etc.) we fall back to file mtime.
//
// Files with no frontmatter at all are skipped with a warning — they're
// unusual and should be fixed manually (adding frontmatter is outside the
// scope of a mechanical backfill).
//
// Atomic writes: read → mutate → write .tmp → rename.
//
// Idempotent: files that already have `last_verified` are left untouched.
//
// Reversible: strip the `last_verified:` lines from affected files. Because
// the values are deterministically re-derivable from git, the reverse is
// equivalent to re-running with the field absent.

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { parseFrontmatter, stringifyFrontmatter } from '../scripts/memory/lib/memory-index.js';

export const id = '0016-backfill-last-verified';
export const description =
  'Backfill last_verified frontmatter from git history (or mtime) for all memory files lacking it.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk dir recursively; yield .md file absolute paths.
 * Skips hidden files/dirs and .tmp files.
 */
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

/**
 * Try to get the most-recent meaningful commit date for a file from git.
 * Uses --diff-filter=AM to capture adds and modifications.
 * Returns YYYY-MM-DD string or null.
 */
function gitDateFor(filePath, gitRoot) {
  try {
    const rel = relative(gitRoot, filePath);
    const out = execSync(
      `git log --diff-filter=AM --follow -1 --format=%cs -- ${JSON.stringify(rel)}`,
      { cwd: gitRoot, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    )
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Convert a Date to YYYY-MM-DD in local time.
 */
function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

  // The git root is two levels above workspaceDir (repo root).
  // workspaceDir = <repo>/robin-assistant, so gitRoot = <repo>/robin-assistant
  // (it's its own git-managed subpath within the larger workspace repo).
  // Try the workspaceDir itself first, then its parent.
  const gitRoot = workspaceDir;

  let stamped = 0;
  let skipped = 0;
  let noFm = 0;

  for (const filePath of walkMd(memDir)) {
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    // Skip files with no frontmatter block — we can't safely inject a field.
    if (Object.keys(frontmatter).length === 0 && !content.startsWith('---')) {
      console.log(`[${id}] SKIP (no frontmatter): ${relative(memDir, filePath)}`);
      noFm++;
      continue;
    }

    // Already stamped — idempotent.
    if (frontmatter.last_verified) {
      skipped++;
      continue;
    }

    // Infer date.
    let date = gitDateFor(filePath, gitRoot);
    if (!date) {
      // Fall back to file mtime.
      const st = statSync(filePath);
      date = toISODate(new Date(st.mtimeMs));
    }

    // Build updated frontmatter preserving existing keys, appending last_verified.
    const newFm = { ...frontmatter, last_verified: date };
    const updated = stringifyFrontmatter(newFm, body);

    // Atomic write.
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, updated, 'utf-8');
    renameSync(tmp, filePath);

    console.log(`[${id}] stamped ${relative(memDir, filePath)} → last_verified: ${date}`);
    stamped++;
  }

  console.log(
    `[${id}] done — stamped: ${stamped}, already had last_verified: ${skipped}, no-frontmatter skip: ${noFm}`,
  );
}
