import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildStamp {
  /** Short git SHA of the commit `pnpm build` ran against (or 'unknown' outside a git checkout). */
  sha: string;
  /** ISO timestamp of when the build finished. */
  at: string;
  /**
   * sha1 digest of the deep dependency tree — `dist/**` EXCLUDING
   * `dist/surfaces/mcp/**` — computed by `write-build-stamp.mjs` as an
   * optional third stamp line. `null` for a legacy 2-line stamp (backward
   * compat) or a build where nothing was hashable (no `dist/` yet).
   *
   * Consumed by the MCP hot-reload's rebuild guard
   * (system/surfaces/mcp/hot-reload.ts, `assertDeepHashCoherent`): its
   * cache-bust only refreshes server.ts's own top-level code, never the
   * deep modules it statically imports (belief.ts, recall.ts, ...) — a
   * differing deep hash means those changed too, so a swap would silently
   * mix code generations. The reload refuses rather than risk that.
   */
  deepHash: string | null;
}

/**
 * Reads `dist/.build-stamp`, written LAST by `system/scripts/write-build-stamp.mjs`
 * as the final step of `pnpm build` (a stamp on disk implies a *complete*
 * build). Line 1 = short git SHA, line 2 = ISO build time, optional line 3 =
 * deep-tree hash (see {@link BuildStamp.deepHash}).
 *
 * Never throws: a missing file (dev mode — dist/ was never built), a corrupt
 * or truncated file, or any other read error all resolve to `null`. Callers
 * treat "no stamp" as "nothing to compare against", not as an error —
 * `mcp.dist_current` relies on that to stay quiet outside a built install.
 */
export function readBuildStamp(repoRoot: string): BuildStamp | null {
  try {
    const raw = readFileSync(join(repoRoot, 'dist', '.build-stamp'), 'utf8');
    const [shaLine, atLine, deepHashLine] = raw.split('\n');
    const sha = shaLine?.trim();
    const at = atLine?.trim();
    if (!sha || !at) return null;
    if (!Number.isFinite(Date.parse(at))) return null;
    const deepHash = deepHashLine?.trim() || null;
    return { sha, at, deepHash };
  } catch {
    return null;
  }
}

// This module's own directory, two levels below the package root whether it
// runs from source (system/lib/build-stamp.ts, tsx dev) or compiled
// (dist/lib/build-stamp.js) — same depth either way, so the stamp is found
// the same way regardless of how this process was started. Deliberately NOT
// process.cwd(): a daemon/MCP server can be launched from any working
// directory (launchd, a client's cwd, …).
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The build SHA *this process* loaded, captured once at import time. A
 * process started before a rebuild keeps this stale value even after
 * `dist/.build-stamp` on disk moves on — that delta is exactly what the
 * `mcp.dist_current` invariant flags. `null` when there's no stamp to read
 * yet (tsx dev, no `pnpm build` run in this checkout).
 */
export const LOADED_SHA: string | null = readBuildStamp(PACKAGE_ROOT)?.sha ?? null;

/**
 * The deep-tree hash *this process* loaded, captured once at import time
 * alongside {@link LOADED_SHA} — same reasoning, same caveats. `null` when
 * there's no stamp yet, or the stamp predates this field (legacy 2-line
 * stamp).
 */
export const LOADED_DEEP_HASH: string | null = readBuildStamp(PACKAGE_ROOT)?.deepHash ?? null;
