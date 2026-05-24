import { join } from 'node:path';
import { buildRobinMcpEntry, type McpEntry } from '../lib/mcp-config/write.ts';

/**
 * Loose stand-in for the SDK's `McpStdioServerConfig`
 * (`{ type?: 'stdio'; command; args?; env? }`). We keep it structural rather than
 * importing the SDK type so this module stays test-friendly and the SDK narrows
 * it at the `mcpServers` boundary (see `sdk.ts`). `McpEntry` from the mcp-config
 * lib already produces exactly this shape, so the two are interchangeable.
 */
export type McpServerConfigLike = McpEntry;

/**
 * Map an `mcp__<server>__<tool>` tool name to its server key, else undefined.
 * The server is the segment between the leading `mcp__` and the next `__`
 * (e.g. `mcp__robin-extension__gmail` → `robin-extension`).
 */
function serverKeyForTool(tool: string): string | undefined {
  if (!tool.startsWith('mcp__')) return undefined;
  const rest = tool.slice('mcp__'.length);
  const end = rest.indexOf('__');
  const key = end === -1 ? rest : rest.slice(0, end);
  return key.length > 0 ? key : undefined;
}

/**
 * Build the stdio server configs for Robin's own MCP surfaces — `robin` (core
 * memory ops) and `robin-extension` (integration ops + per-source tools) — so an
 * agentic run can actually invoke `mcp__robin__*` / `mcp__robin-extension__*`.
 *
 * Reuses `buildRobinMcpEntry` (the same helper `mcp install` writes into
 * `~/.claude.json`) so the launch command matches `.mcp.json.example`:
 * `node dist/surfaces/cli/index.js mcp <surface>`. The CLI binary is resolved
 * from `repoRoot` (not `process.argv[1]`, which under the detached runner points
 * at runner-entry, not the CLI), and `resolveRunnableCommand` rewrites the `.ts`
 * source path to its compiled `dist/.js` sibling (throwing if `pnpm build`
 * hasn't run). `ROBIN_USER_DATA_DIR` is pinned so the spawned server reads the
 * same instance data as the run.
 */
export function robinMcpServers(opts: {
  repoRoot: string;
  userDataDir?: string;
}): Record<string, McpServerConfigLike> {
  // The CLI source the helper resolves to dist/surfaces/cli/index.js.
  const cliSource = join(opts.repoRoot, 'system', 'surfaces', 'cli', 'index.ts');
  const common = {
    command: cliSource,
    ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
  };
  return {
    robin: buildRobinMcpEntry({ ...common, surface: 'core' }),
    'robin-extension': buildRobinMcpEntry({ ...common, surface: 'extension' }),
  };
}

/**
 * Narrow a full server map to only the servers a handler's `allowedTools`
 * actually reference. A tool `mcp__<server>__<x>` pins server `<server>`; tool
 * lists with no `mcp__` entries yield an empty map (so built-in-only handlers
 * spawn no MCP subprocess). Servers named in tools but absent from `all` are
 * skipped — the allowlist is authoritative, but we can't conjure a config we
 * weren't given.
 */
export function serversForTools(
  allowedTools: string[],
  all: Record<string, McpServerConfigLike>,
): Record<string, McpServerConfigLike> {
  const out: Record<string, McpServerConfigLike> = {};
  for (const tool of allowedTools) {
    const key = serverKeyForTool(tool);
    if (key && key in all && !(key in out)) out[key] = all[key];
  }
  return out;
}

/**
 * One-shot helper for `runAgent` call sites: returns the MCP server configs a
 * handler's `allowedTools` need, or `{}` when none are referenced. The short
 * circuit matters — a built-in-only handler (e.g. B research) must NOT trigger
 * `robinMcpServers`, which resolves (and requires) the compiled CLI binary.
 */
export function mcpServersForRun(
  allowedTools: string[],
  opts: { repoRoot: string; userDataDir?: string },
): Record<string, McpServerConfigLike> {
  const needsAny = allowedTools.some((t) => serverKeyForTool(t) !== undefined);
  if (!needsAny) return {};
  return serversForTools(allowedTools, robinMcpServers(opts));
}
