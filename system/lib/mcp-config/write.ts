import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export interface McpEntry {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Update ~/.claude.json (user-scope) with an MCP entry under the given name.
 * Defaults to 'robin' for backwards compatibility. If an entry with the same
 * name already exists, it is REPLACED.
 */
export function upsertUserScopeMcp(
  entry: McpEntry,
  opts?: { home?: string; name?: string },
): { path: string; replaced: boolean } {
  const home = opts?.home ?? homedir();
  const name = opts?.name ?? 'robin';
  const claudeConfigPath = join(home, '.claude.json');
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(claudeConfigPath)) {
    try {
      config = JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
    } catch {
      // ignore parse errors; start fresh below
    }
  }
  if (!config.mcpServers) config.mcpServers = {};
  const replaced = name in config.mcpServers;
  config.mcpServers[name] = entry;
  writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
  return { path: claudeConfigPath, replaced };
}

/**
 * Resolve a script path into a runnable absolute command. If the script is a
 * `.ts` source file (dev mode under tsx), derive the matching compiled `.js`
 * under `dist/`. Throws if the compiled output is missing.
 */
export function resolveRunnableCommand(input: string): string {
  if (!input) {
    throw new Error('Cannot resolve MCP command: empty script path');
  }
  const abs = resolve(input);
  if (!abs.endsWith('.ts')) return abs;
  // Locate the `system/` directory component and swap it for `dist/`. Uses the
  // separator-delimited marker so `/other/system/` in the prefix doesn't match.
  const marker = `${sep}system${sep}`;
  const idx = abs.lastIndexOf(marker);
  const distPath =
    idx >= 0
      ? `${abs.slice(0, idx)}${sep}dist${sep}${abs.slice(idx + marker.length).replace(/\.ts$/, '.js')}`
      : abs.replace(/\.ts$/, '.js');
  if (!existsSync(distPath)) {
    throw new Error(
      `Cannot install MCP entry from ${abs}: run \`pnpm build\` first ` +
        `(expected compiled binary at ${distPath}).`,
    );
  }
  return distPath;
}

/**
 * Build the canonical Robin MCP entry. The command resolves to the absolute
 * path of the running CLI binary (falling back to argv[1]); the env field
 * pins ROBIN_USER_DATA_DIR so the spawned server uses the same user-data the
 * installer was pointed at. `surface` picks between the two MCP servers:
 *   - 'core' (default): memory ops — recall, remember, find_entity, journal, etc.
 *   - 'extension': integration ops + per-source tools — gmail, calendar,
 *     linear, chrome, finance, plus user-extension actions
 *
 * Both surfaces are registered separately so Claude sees tool names like
 * `mcp__robin__recall` (core) and `mcp__robin-extension__gmail` (extension).
 */
export function buildRobinMcpEntry(opts?: {
  command?: string;
  userDataDir?: string;
  surface?: 'core' | 'extension';
}): McpEntry {
  const rawCommand = opts?.command ?? process.argv[1] ?? '';
  const command = resolveRunnableCommand(rawCommand);
  const userDataDir = opts?.userDataDir ?? process.env.ROBIN_USER_DATA_DIR;
  const surface = opts?.surface ?? 'core';
  const entry: McpEntry = { type: 'stdio', command, args: ['mcp', surface] };
  if (userDataDir) {
    entry.env = { ROBIN_USER_DATA_DIR: userDataDir };
  }
  return entry;
}
