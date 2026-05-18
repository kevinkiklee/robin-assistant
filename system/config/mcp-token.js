import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './data-store.js';

// Persistent bearer token gating the MCP HTTP surface (/sse, /messages,
// /internal/*). Stored at runtime/mcp-token with mode 0600.
//
// Persistence matters: the token is embedded in .mcp.json's headers so
// Claude Code (and any other MCP client) can authenticate. If the token
// rotated every daemon boot, .mcp.json would go stale on every restart
// and MCP would refuse all calls until the wiring invariant re-ran.
//
// Rotation: delete the file and restart the daemon.

const TOKEN_BYTES = 32; // 256 bits → 64 hex chars

function readTokenFile(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  // Sanity-check format. A truncated or otherwise corrupted token file
  // would happily authenticate `Bearer <truncated>` if we trusted the
  // contents blindly; insist on hex of expected length so corruption
  // surfaces as a re-mint rather than a silent auth bypass.
  if (!/^[0-9a-f]+$/i.test(raw) || raw.length !== TOKEN_BYTES * 2) return null;
  return raw;
}

function writeTokenFile(path, token) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, token, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function readMcpToken() {
  return readTokenFile(paths.data.mcpToken());
}

export function ensureMcpToken() {
  const path = paths.data.mcpToken();
  const existing = readTokenFile(path);
  if (existing) return existing;
  const fresh = randomBytes(TOKEN_BYTES).toString('hex');
  writeTokenFile(path, fresh);
  return fresh;
}
