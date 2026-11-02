// system/scripts/deep-hash.mjs — sha1 of the "deep" dependency tree under a
// compiled dist/ output, excluding files a caller's cache-busted self-import
// already refreshes on every reload (so their own content changing
// shouldn't block a swap). Extracted from write-build-stamp.mjs so the
// exclusion boundary is independently testable — see deep-hash.test.ts.
// Consumed by write-build-stamp.mjs (thin CLI) and, indirectly, by
// system/surfaces/mcp/hot-reload.ts's assertDeepHashCoherent, which compares
// the hash this produces at build time against what a running process
// loaded.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Files the MCP core hot-reload's cache-bust re-executes directly on every
 * reload (system/surfaces/mcp/core/server.ts self-importing its own compiled
 * URL) — safe to exclude from the deep hash because their content changing
 * is exactly what the reload already picks up fresh. `server.d.ts` is
 * generated FROM server.ts and changes in lockstep with it (e.g. a new
 * exported interface field) — leaving it in the hash would make an ordinary
 * server.ts-only change spuriously trip the guard even though the
 * self-import safely refreshes server.ts's own code in full.
 *
 * Deliberately NOT the whole `surfaces/mcp/**` subtree (the original,
 * over-broad version of this exclusion): server.ts statically imports
 * sibling files under mcp/ that are NOT refreshed by the self-import —
 * `skill-tool.ts` (real per-call business logic, invoked from the `skill`
 * tool's callback) and `hot-reload.ts` itself. A change to either must still
 * refuse an unsafe swap, exactly the class of bug this hash exists to catch.
 * The extension/remote MCP surfaces aren't reachable from core/server.ts's
 * import graph at all, so including them is conservative rather than
 * load-bearing: a change there can't cause a mixed-version bug in the core
 * server, but there's no correctness reason to carve them out either.
 */
export const SELF_IMPORTED_FILES = new Set([
  'surfaces/mcp/core/server.js',
  'surfaces/mcp/core/server.d.ts',
]);

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out;
}

/**
 * sha1 over sorted `relativePath:fileSha1` pairs for every file under
 * `distRoot`, excluding `.build-stamp` (the file being written, when this
 * runs as part of the real build) and every path in `excludeFiles` (exact
 * relative-path matches, POSIX-separated regardless of platform).
 *
 * @param {string} distRoot
 * @param {ReadonlySet<string>} [excludeFiles]
 * @returns {string | null} `null` if `distRoot` doesn't exist or nothing is
 *   left to hash.
 */
export function computeDeepHash(distRoot, excludeFiles = new Set()) {
  let files;
  try {
    files = listFiles(distRoot);
  } catch {
    return null; // distRoot missing — nothing to hash
  }
  const hashable = files.filter((f) => f !== '.build-stamp' && !excludeFiles.has(f));
  if (hashable.length === 0) return null;
  const pairs = hashable
    .map((f) => {
      const fileSha = createHash('sha1')
        .update(readFileSync(join(distRoot, f)))
        .digest('hex');
      return `${f}:${fileSha}`;
    })
    .sort();
  return createHash('sha1').update(pairs.join('\n')).digest('hex');
}
