// Cycle-2b: shared helpers for tamper-detection manifest.
//
// loadManifest      — read user-data/security/manifest.json. Auto-creates
//                     v2 fields (cycle-2c forward-compat). Returns null
//                     if file missing.
// enumerateMCPServers — best-effort list of MCP server names currently
//                     registered, drawn from project + global Claude Code
//                     config files.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MANIFEST_REL = 'user-data/security/manifest.json';
const SCAFFOLD_REL = 'system/scaffold/security/manifest.json';

export function manifestPath(workspaceDir) {
  return join(workspaceDir, MANIFEST_REL);
}

export function scaffoldManifestPath(workspaceDir, packageRoot) {
  return packageRoot ? join(packageRoot, SCAFFOLD_REL) : join(workspaceDir, SCAFFOLD_REL);
}

// Read the manifest. Returns null if missing or malformed; auto-fills
// missing v2 fields (agentsmd, userDataJobs) so cycle-2c can layer in.
export function loadManifest(workspaceDir) {
  const p = manifestPath(workspaceDir);
  if (!existsSync(p)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (!data.hooks) data.hooks = {};
  if (!data.mcpServers) data.mcpServers = { expected: [], writeCapable: [] };
  if (!Array.isArray(data.mcpServers.expected)) data.mcpServers.expected = [];
  if (!Array.isArray(data.mcpServers.writeCapable)) data.mcpServers.writeCapable = [];
  // v2 fields added by cycle-2c. Default empty for v1.
  if (!data.agentsmd) data.agentsmd = { hardRulesHash: '', lastSnapshot: '' };
  if (!data.userDataJobs) data.userDataJobs = { knownFiles: [] };
  return data;
}

export function writeManifest(workspaceDir, data) {
  const p = manifestPath(workspaceDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

// Copy scaffold → live manifest on first install if user-data version
// doesn't yet exist. Idempotent. Used by setup.js postinstall.
// packageRoot is set when robin-assistant is installed globally and the
// scaffold lives outside the workspace (e.g. inside the npm-global lib dir).
export function ensureManifestFromScaffold(workspaceDir, packageRoot) {
  const live = manifestPath(workspaceDir);
  if (existsSync(live)) return { copied: false };
  const skel = scaffoldManifestPath(workspaceDir, packageRoot);
  if (!existsSync(skel)) return { copied: false, reason: 'no-scaffold' };
  mkdirSync(dirname(live), { recursive: true });
  writeFileSync(live, readFileSync(skel, 'utf-8'));
  return { copied: true };
}

// Read the project's `.claude/settings.json`. Returns null if missing.
export function loadCurrentSettings(workspaceDir) {
  const p = join(workspaceDir, '.claude/settings.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function readJSONOrEmpty(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// Best-effort enumeration of currently-registered MCP server names.
//
// Sources tried, in order:
//   1. <workspaceDir>/.mcp.json (project-scoped MCPs)
//   2. ~/.claude/mcp_settings.json (global, older convention)
//   3. ~/.claude/settings.json (global, newer convention with mcpServers field)
//   4. ~/Library/Application Support/Claude/claude_desktop_config.json (desktop app)
//
// Fails soft on missing/malformed paths; returns whatever it can. Result
// is deduped + sorted.
export function enumerateMCPServers(workspaceDir) {
  const servers = new Set();
  const candidates = [
    join(workspaceDir, '.mcp.json'),
    join(homedir(), '.claude', 'mcp.json'),
    join(homedir(), '.claude', 'mcp_settings.json'),
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  ];
  for (const path of candidates) {
    const config = readJSONOrEmpty(path);
    if (!config) continue;
    if (config.mcpServers && typeof config.mcpServers === 'object') {
      for (const name of Object.keys(config.mcpServers)) servers.add(name);
    }
  }
  return [...servers].sort();
}
