import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface McpEntry {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Update ~/.claude.json (user-scope) with Robin's MCP entry under name 'robin'.
 * If an existing 'robin' entry exists (from v2 or otherwise), it is REPLACED.
 * Returns { path, replaced } where replaced=true if there was a prior entry.
 */
export function upsertUserScopeMcp(
  entry: McpEntry,
  opts?: { home?: string },
): { path: string; replaced: boolean } {
  const home = opts?.home ?? homedir();
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
  const replaced = 'robin' in config.mcpServers;
  config.mcpServers.robin = entry;
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
  const distPath = abs.replace('/system/', '/dist/').replace(/\.ts$/, '.js');
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
 * installer was pointed at.
 */
export function buildRobinMcpEntry(opts?: { command?: string; userDataDir?: string }): McpEntry {
  const rawCommand = opts?.command ?? process.argv[1] ?? '';
  const command = resolveRunnableCommand(rawCommand);
  const userDataDir = opts?.userDataDir ?? process.env.ROBIN_USER_DATA_DIR;
  const entry: McpEntry = { type: 'stdio', command, args: ['mcp', 'core'] };
  if (userDataDir) {
    entry.env = { ROBIN_USER_DATA_DIR: userDataDir };
  }
  return entry;
}
