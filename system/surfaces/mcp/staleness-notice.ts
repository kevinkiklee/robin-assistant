import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * A non-blocking counterpart to the core server's hot-reload guard
 * (system/surfaces/mcp/hot-reload.ts).
 *
 * The core server can *refuse* when it goes stale because a refusal costs only
 * a retry. The extension server can't take that trade: it holds the tools that
 * DO things (`run`, `agent`, `update`, `discord`, `linear` writes, `gmail`),
 * and a hard refusal there would mean every `pnpm build` simultaneously
 * disarms every open session's ability to act — with N sessions typically
 * alive at once, that is a worse failure than the staleness itself.
 *
 * So this warns instead of refusing. Before it existed the extension server had
 * no build-stamp awareness at all: it would silently serve code from whatever
 * build the process started on, days old, reporting success the whole time. The
 * notice makes that visible at the call site, which is the only place a caller
 * can act on it.
 */

/** The identifying pair from a `dist/.build-stamp` — see lib/build-stamp.ts. */
export interface StampIdentity {
  sha: string | null;
  deepHash: string | null;
}

const RECONNECT = 'Reconnect MCP servers (/mcp) to pick up the current build.';

/**
 * Builds the warning shown alongside a tool result when this process's code is
 * older than `dist/`. Returns `null` when there is nothing to warn about.
 *
 * Checks the DEEP HASH first, and that ordering is the whole point. The stamp's
 * sha is `git rev-parse --short HEAD`, which does NOT move when `pnpm build`
 * runs against uncommitted work — the normal state of this repo during
 * development. A sha-only comparison therefore reports "fresh" for the most
 * common rebuild there is. The deep hash is content-derived over all of
 * `dist/**`, so it catches that case; the sha is kept because it's the part a
 * human can act on ("which build am I on").
 *
 * A `null` on either side of a comparison means "no basis for comparison" (tsx
 * dev with no build, a legacy 2-line stamp, a stamp that couldn't be read) and
 * is deliberately NOT treated as staleness — same reasoning as
 * `assertDeepHashCoherent`. Warning on unknown would cry wolf on every dev run
 * and train the reader to ignore it.
 */
export function stalenessNotice(loaded: StampIdentity, current: StampIdentity): string | null {
  const shasComparable = loaded.sha !== null && current.sha !== null;
  const shaMoved = shasComparable && loaded.sha !== current.sha;

  if (shaMoved) {
    return (
      `⚠️ Robin extension MCP server is running STALE code: this process loaded build ${loaded.sha}, ` +
      `but dist/ is now ${current.sha}. The result above came from the OLD build and may not ` +
      `reflect current behaviour. ${RECONNECT}`
    );
  }

  const deepComparable = loaded.deepHash !== null && current.deepHash !== null;
  if (deepComparable && loaded.deepHash !== current.deepHash) {
    return (
      '⚠️ Robin extension MCP server is running STALE code: dist/ has been rebuilt since this ' +
      `process started. The commit is unchanged (${loaded.sha ?? 'unknown'}), so this is a rebuild ` +
      `from uncommitted changes. The result above came from the OLD build. ${RECONNECT}`
    );
  }

  return null;
}

/**
 * Appends `notice` to a tool result as an extra text block, leaving the
 * original payload first and untouched.
 *
 * Order matters: every caller of these tools parses `content[0]` as the JSON
 * payload, so the banner has to go last. The input result is never mutated —
 * callbacks may hand back a shared or frozen object.
 */
export function appendStalenessNotice(
  result: CallToolResult,
  notice: string | null,
): CallToolResult {
  if (notice === null) return result;
  return { ...result, content: [...result.content, { type: 'text', text: notice }] };
}

/**
 * Anything with McpServer's `registerTool` shape. Structural rather than the
 * concrete class so the unit tests can drive this with a plain object instead
 * of standing up a real server and transport.
 */
export interface ToolRegistrar {
  // biome-ignore lint/suspicious/noExplicitAny: type-erasure boundary — registerTool is generic over each tool's distinct zod shape, and this wrapper never inspects config or args, it only forwards them.
  registerTool: (name: string, config: any, cb: any) => unknown;
}

/**
 * Replaces `registrar.registerTool` in place so every tool registered
 * afterwards carries the staleness notice.
 *
 * Patching the registrar once, rather than wrapping ~13 call sites, is
 * deliberate: it is the only approach that also covers the user-data extension
 * tools, which `registerUserExtensionActions` registers ASYNCHRONOUSLY after
 * the server has already been returned to the client. It also makes the guard
 * the default for any tool added later — the same "new tools are safe by
 * default" property the core server gets from its allowlist gate.
 *
 * `readNotice` is consulted per invocation and deliberately AFTER the tool
 * runs: a process registers its tools while fresh and goes stale hours later,
 * so a single read at registration time would never fire for the long-lived
 * sessions that need it most — and reading afterwards also catches a build that
 * landed while a slow tool (an agent run) was still going.
 */
export function wrapRegistrarWithStalenessNotice(
  registrar: ToolRegistrar,
  readNotice: () => string | null,
): void {
  const register = registrar.registerTool.bind(registrar);
  registrar.registerTool = (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => Promise<CallToolResult>,
  ): unknown => {
    const wrapped = async (...args: unknown[]): Promise<CallToolResult> => {
      // No try/catch: a throwing tool must keep throwing exactly as it did
      // before, so the SDK's own error envelope is unchanged. A notice is
      // worth less than a faithful error.
      const result = await cb(...args);
      return appendStalenessNotice(result, readNotice());
    };
    return register(name, config, wrapped);
  };
}
