import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../../integrations/_runtime/types.ts';
import { LOADED_DEEP_HASH, LOADED_SHA, readBuildStamp } from '../../lib/build-stamp.ts';

/**
 * Any MCP tool callback, regardless of its input schema. The dispatch table
 * this module swaps is heterogeneous across tools (each has its own zod
 * shape), and this module never inspects args — it only picks which function
 * to call and forwards whatever it was given. `ToolCallback<any>` is the same
 * generic the registration gate in server.ts uses, instantiated loosely
 * enough to hold every tool's concrete callback.
 */
// biome-ignore lint/suspicious/noExplicitAny: type-erasure boundary — the table spans every tool's distinct zod schema, and ToolCallback<any> is the SDK's own generic, not a hand-rolled shape.
export type ToolCb = ToolCallback<any>;

export interface CreateReloadableDispatchOptions {
  /**
   * Repo/package root `dist/.build-stamp` is resolved under — same
   * convention as every other `readBuildStamp` caller (doctor-set.ts,
   * dist-current.ts): never `process.cwd()`, always the package's own
   * on-disk location.
   */
  repoRoot: string;
  /**
   * Rebuilds the full name→callback table from whatever is currently on disk
   * in `dist/`. Real callers cache-bust-import the tool-callback factory
   * module and construct entirely fresh dependencies (DB handle, LLM
   * dispatcher) the same way server startup does; unit tests inject a fake
   * that never touches a real module loader or filesystem beyond the stamp
   * file itself.
   */
  rebuild: () => Promise<Map<string, ToolCb>>;
  log: Logger;
  /**
   * The sha this process's ORIGINALLY-REGISTERED callbacks were actually
   * built from. Defaults to {@link LOADED_SHA} (captured once at process
   * start) — deliberately NOT a fresh disk read at construction time.
   *
   * A disk read is only correct for a caller that constructs the dispatch
   * exactly once, at process start (the stdio core server). The remote HTTP
   * surface builds a server PER REQUEST, long after process start — a disk
   * read there reports whatever happens to be on disk AT THAT MOMENT as the
   * baseline, so every request always believes itself perfectly fresh
   * regardless of what code this process actually has loaded and cached,
   * permanently defeating the reload (task-4 review finding 1). `LOADED_SHA`
   * is fixed for the process's entire lifetime and reflects reality no
   * matter how many times `createReloadableDispatch` gets called.
   *
   * `null` is itself a valid injected baseline (dev/test with no real
   * stamp), which is why this is checked against `undefined` rather than
   * defaulted with `??`.
   */
  initialSha?: string | null;
  /**
   * The deep-tree hash this process's callbacks were built from. Defaults to
   * {@link LOADED_DEEP_HASH}, captured once at process start, for the same
   * reason {@link CreateReloadableDispatchOptions.initialSha} defaults to
   * `LOADED_SHA`.
   *
   * Load-bearing because the stamp's sha is `git rev-parse --short HEAD`,
   * which does NOT move when `pnpm build` runs against uncommitted work — the
   * normal state during development. Comparing shas alone therefore reported
   * "already running what's on disk" for the most common rebuild there is, and
   * this process went on silently serving the previous build. The deep hash is
   * content-derived over `dist/**`, so it catches that case.
   *
   * `null` is a valid injected baseline, hence the `undefined` check rather
   * than `??`.
   */
  initialDeepHash?: string | null;
}

export interface ReloadableDispatch {
  /**
   * Registers `cb` as the permanent fallback for `name` and returns a
   * delegating callback. Every invocation: (1) runs {@link checkAndReload},
   * (2) if a prior reload attempt is stuck failing for the sha currently on
   * disk, returns a loud MCP-error result instead of running any tool logic,
   * (3) otherwise dispatches to the current table's entry for `name` if a
   * reload has ever happened, or to the originally-registered `cb` if none
   * has. Once a table exists, a `name` missing from it (e.g. a tool removed
   * or renamed in the new build) is ALSO a loud error rather than a fallback
   * to `cb` — `cb`'s closure holds the startup DB handle, which a successful
   * reload has already closed, so calling it would not "keep working",
   * it would fail some other, more confusing way.
   */
  wrap: (name: string, cb: ToolCb) => ToolCb;
  /**
   * Reload check + swap. Runs at the very start of every wrapped invocation
   * — never mid-request — so a request either sees the pre-reload world or
   * the post-reload world in full, never a torn mix of the two. Concurrent
   * callers that both observe staleness share a single in-flight rebuild
   * (memoized, cleared on settle) rather than racing two independent ones —
   * two rebuilds racing to `closeDb` a shared handle is exactly the failure
   * mode this guards against. Exported separately so tests can drive the
   * reload transition directly.
   */
  checkAndReload: () => Promise<void>;
}

function staleErrorResult(
  builtSha: string,
  runningSha: string | null,
  reason: string | null,
): CallToolResult {
  const reasonSuffix = reason ? ` Reason: ${reason}` : '';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          `Robin MCP server is stale (built ${builtSha}, running ${runningSha}) ` +
          `and hot-reload failed; reconnect MCP servers (/mcp) or restart the client.${reasonSuffix}`,
      },
    ],
  };
}

function toolAbsentResult(name: string, runningSha: string | null): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          `Robin MCP tool '${name}' is absent from the reloaded build (now running ${runningSha}) — ` +
          "its original startup callback's DB handle was already closed by the reload, so it can't " +
          'safely run either; reconnect MCP servers (/mcp) or restart the client.',
      },
    ],
  };
}

/**
 * Throws when two deep-tree hashes disagree and both are known. A hot-reload
 * cache-bust only refreshes the top-level module it self-imports — it never
 * refreshes what THAT module statically imports (deep business logic), which
 * stays on whatever this process cached at start. If the deep tree changed
 * too, swapping in fresh top-level glue against those still-cached deep
 * modules could silently produce a mixed-version graph (e.g. new glue
 * passing a renamed options key to an old, still-cached function that
 * doesn't know about it). Refusing the swap is the only way to guarantee a
 * successful reload implies full coherence.
 *
 * `null` on either side ("no deep hash to compare") is treated as nothing to
 * check, not a mismatch — backward compat with stamps written before this
 * field existed (2-line legacy stamps) and with builds that produced no
 * hashable output.
 */
export function assertDeepHashCoherent(
  loadedDeepHash: string | null,
  currentDeepHash: string | null,
): void {
  if (loadedDeepHash === null || currentDeepHash === null) return;
  if (loadedDeepHash === currentDeepHash) return;
  throw new Error(
    `deep-module hash mismatch (expected ${loadedDeepHash}, found ${currentDeepHash}): ` +
      "modules outside this reload's own subtree changed too, and mixing this process's " +
      'still-cached deep modules with a new top-level build is not safe. A full reconnect is ' +
      'required — reconnect MCP servers (/mcp) or restart the client.',
  );
}

/**
 * Opaque identity of a build: the pair that together says "which compiled
 * code is this". Used as the sticky-failure key so a dirty-tree rebuild
 * (unchanged sha, moved deep hash) is a distinct target from the build that
 * already failed.
 */
export function identityKey(sha: string | null, deepHash: string | null): string {
  return `${sha ?? ''} ${deepHash ?? ''}`;
}

/**
 * Whether the build on disk differs from the one this process is running.
 *
 * The sha comparison is plain inequality, `null` included — deliberately the
 * original pre-deep-hash semantics, which this function must preserve exactly.
 * A process that loaded no stamp (tsx dev) while disk HAS one is stale, and so
 * is the reverse; treating either as "no basis for comparison" would silently
 * disable the reload in exactly those cases. (Weakening this to a both-non-null
 * check broke `initialSha undefined falls back to LOADED_SHA` — invisibly on a
 * machine with `dist/` built, caught in CI where LOADED_SHA is null.)
 *
 * The deep hash is then an ADDITIONAL signal, checked only when the shas agree
 * and both hashes exist: it catches a rebuild from uncommitted work, which
 * leaves the sha untouched by construction. Here a `null` genuinely does mean
 * "no basis for comparison" (legacy 2-line stamp, or a build with nothing
 * hashable), so it must not by itself imply staleness.
 */
export function isStale(
  activeSha: string | null,
  activeDeepHash: string | null,
  currentSha: string | null,
  currentDeepHash: string | null,
): boolean {
  if (activeSha !== currentSha) return true;
  if (activeDeepHash !== null && currentDeepHash !== null && activeDeepHash !== currentDeepHash)
    return true;
  return false;
}

/**
 * Detects when `dist/.build-stamp` moves past the build this process's tool
 * table was built from, and swaps in a freshly rebuilt table in place — the
 * in-process remedy for "MCP servers silently serve stale code after a
 * rebuild" (see `mcp.dist_current` in
 * system/kernel/invariants/builtins/dist-current.ts, which is the boot/health
 * assertion for the case this module can't fix in-process: no dist/build
 * change to react to, or a reload that keeps failing).
 */
export function createReloadableDispatch(
  opts: CreateReloadableDispatchOptions,
): ReloadableDispatch {
  const { repoRoot, rebuild, log } = opts;

  let activeSha: string | null = opts.initialSha !== undefined ? opts.initialSha : LOADED_SHA;
  let activeDeepHash: string | null =
    opts.initialDeepHash !== undefined ? opts.initialDeepHash : LOADED_DEEP_HASH;
  let table: Map<string, ToolCb> | null = null;
  // The build identity a rebuild attempt already failed for, and the sha from
  // that identity for the error message. Sticky until the on-disk build moves
  // again: retrying an already-broken build on every single MCP call would
  // burn a dynamic import + DB open + migration pass per request for no new
  // information. Keyed on the FULL identity (sha + deep hash), not the sha
  // alone, so a dirty-tree rebuild — where the sha is unchanged by
  // construction — is still a distinct target rather than being mistaken for
  // the one that already failed.
  let reloadFailedKey: string | null = null;
  let reloadFailedSha: string | null = null;
  // The message from the most recent rebuild failure — folded into the loud
  // error text so a caller sees WHY (e.g. a deep-hash mismatch), not just
  // THAT it failed.
  let lastRebuildErrorMessage: string | null = null;
  // Single-flight: two concurrent stale calls must share one rebuild, not
  // race two independent ones (the second's closeDb would close the DB
  // handle the first just swapped in). Assigned synchronously — with no
  // `await` between the guard checks above and this assignment — so two
  // interleaved callers always agree on whether a rebuild is already
  // underway before either one starts its own; see checkAndReload.
  let inFlightRebuild: Promise<void> | null = null;

  async function checkAndReload(): Promise<void> {
    const stamp = readBuildStamp(repoRoot);
    const currentSha = stamp?.sha ?? null;
    const currentDeepHash = stamp?.deepHash ?? null;
    if (!isStale(activeSha, activeDeepHash, currentSha, currentDeepHash)) return;
    const currentKey = identityKey(currentSha, currentDeepHash);
    if (currentKey === reloadFailedKey) return; // known-bad target; wait for it to move again

    if (!inFlightRebuild) {
      const targetSha = currentSha;
      const targetDeepHash = currentDeepHash;
      const targetKey = currentKey;
      inFlightRebuild = rebuild()
        .then((newTable) => {
          const oldSha = activeSha;
          table = newTable;
          activeSha = targetSha;
          activeDeepHash = targetDeepHash;
          reloadFailedKey = null;
          reloadFailedSha = null;
          lastRebuildErrorMessage = null;
          log.info({ oldSha, newSha: activeSha }, 'mcp hot-reload: swapped dispatch table');
        })
        .catch((err) => {
          reloadFailedKey = targetKey;
          reloadFailedSha = targetSha;
          lastRebuildErrorMessage = err instanceof Error ? err.message : String(err);
          log.error(
            { err, targetSha, activeSha },
            'mcp hot-reload: rebuild failed, keeping previous dispatch table',
          );
        })
        .finally(() => {
          inFlightRebuild = null;
        });
    }
    await inFlightRebuild;
  }

  function wrap(name: string, cb: ToolCb): ToolCb {
    const wrapped = async (...args: unknown[]): Promise<CallToolResult> => {
      await checkAndReload();
      // Re-read rather than trust a value captured before checkAndReload ran:
      // if the on-disk sha has since reverted to activeSha (e.g. a bad build
      // got replaced by the previous good one again), reloadFailedSha now
      // names a target that is no longer current, and this must NOT keep
      // erroring on a server that is in fact fine.
      const stamp = readBuildStamp(repoRoot);
      const currentKey = identityKey(stamp?.sha ?? null, stamp?.deepHash ?? null);
      if (reloadFailedKey !== null && currentKey === reloadFailedKey) {
        return staleErrorResult(reloadFailedSha ?? 'unknown', activeSha, lastRebuildErrorMessage);
      }
      if (table !== null) {
        const current = table.get(name);
        if (current === undefined) {
          return toolAbsentResult(name, activeSha);
        }
        return (current as (...a: unknown[]) => Promise<CallToolResult>)(...args);
      }
      return (cb as (...a: unknown[]) => Promise<CallToolResult>)(...args);
    };
    return wrapped as ToolCb;
  }

  return { wrap, checkAndReload };
}
