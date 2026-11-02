import { readBuildStamp } from '../../../lib/build-stamp.ts';
import type { Invariant } from '../types.ts';

/**
 * Detects a long-lived process (daemon, MCP server) serving a stale build:
 * `dist/.build-stamp` on disk (written LAST by `pnpm build`) carries a
 * different git SHA than the one this process loaded at import time
 * (`LOADED_SHA` in `system/lib/build-stamp.ts`). A mismatch means `pnpm
 * build` ran again after this process started, and it's still running the
 * old compiled code.
 *
 * `ok` whenever there's nothing to compare: no stamp on disk (dev mode — no
 * `pnpm build` has run in this checkout) or this process captured no SHA at
 * import (also dev mode — running via tsx straight from source, never
 * loaded dist/). Only fires when BOTH sides have a SHA and they disagree.
 *
 * No `repair()`: there's nothing this check can do to itself to fix
 * staleness — the fix is a restart. Task 4's hot-reload is the in-process
 * remedy where one applies; for the daemon this invariant is a
 * daemon-staleness check surfaced via the daily doctor.
 */
export function distCurrentInvariant(opts: {
  /** Repo/package root to resolve dist/.build-stamp against. */
  repoRoot: string;
  /** The SHA this process loaded at start. Injectable for tests; production
   *  callers pass `() => LOADED_SHA` from system/lib/build-stamp.ts. */
  loadedSha: () => string | null;
  /**
   * The deep-tree hash this process loaded at start; production callers pass
   * `() => LOADED_DEEP_HASH`. Defaults to "nothing to compare", which
   * preserves the original sha-only behaviour for callers that don't supply
   * it.
   *
   * Needed because the stamp's sha is `git rev-parse --short HEAD`, which does
   * NOT move when `pnpm build` runs against uncommitted work. A sha-only
   * comparison therefore reported "current" for the most common rebuild in
   * this repo, and a daemon serving pre-rebuild code passed the daily doctor.
   */
  loadedDeepHash?: () => string | null;
}): Invariant {
  return {
    name: 'mcp.dist_current',
    severity: 'warning',
    symptom:
      'A long-lived process (daemon, MCP server) is running compiled code older than what is currently on disk in dist/.',
    cause:
      '`pnpm build` ran again after this process started and loaded its code; the process is still serving the previous build.',
    fix: 'Confirm `dist/` is itself current first (`cat dist/.build-stamp` vs `git rev-parse --short HEAD`) and run `pnpm build` if not — restarting onto a stale dist leaves the process stale. Then restart: `launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon` for the daemon, or reconnect the MCP server / client session.',
    check: () => {
      const stamp = readBuildStamp(opts.repoRoot);
      if (!stamp) return { ok: true }; // dev mode — nothing built yet to compare against
      const loaded = opts.loadedSha();
      if (!loaded) return { ok: true }; // this process never loaded a stamp (tsx dev)
      if (loaded !== stamp.sha) {
        return {
          ok: false,
          message: `process loaded build ${loaded} but dist/.build-stamp is now ${stamp.sha} — running code is stale`,
          remediation: 'restart the process to pick up the rebuild',
        };
      }
      // Same commit, but dist/ may still have been rebuilt from uncommitted
      // work — the sha cannot see that, the content-derived deep hash can. A
      // null on either side means "no basis for comparison" (legacy 2-line
      // stamp, or a build with nothing hashable), never "changed".
      const loadedDeep = opts.loadedDeepHash?.() ?? null;
      if (loadedDeep !== null && stamp.deepHash !== null && loadedDeep !== stamp.deepHash) {
        return {
          ok: false,
          message: `dist/ was rebuilt from uncommitted changes since this process started (commit ${loaded} unchanged, deep hash ${loadedDeep.slice(0, 12)} → ${stamp.deepHash.slice(0, 12)}) — running code is stale`,
          remediation: 'restart the process to pick up the rebuild',
        };
      }
      return { ok: true };
    },
    // No repair() — see doc comment above: the fix is a restart, not something
    // this check can perform on itself.
  };
}
