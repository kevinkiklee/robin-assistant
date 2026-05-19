import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface McpEntry {
  type: 'stdio';
  command: string;
  args: string[];
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
  config.mcpServers['robin'] = entry;
  // Write atomically: write to tmp then rename
  writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
  return { path: claudeConfigPath, replaced };
}

/**
 * Build the canonical Robin MCP entry that points at the installed binary path.
 * For dev mode, the user can override via opts.command.
 */
export function buildRobinMcpEntry(opts?: { command?: string; userDataDir?: string }): McpEntry {
  const command = opts?.command ?? join(process.cwd(), 'node_modules', '.bin', 'robin');
  const args = ['mcp', 'core'];
  return { type: 'stdio', command, args };
}
