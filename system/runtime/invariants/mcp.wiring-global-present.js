// mcp.wiring_global_present
//
// ~/.claude.json's mcpServers.robin entry is convenience — agents running
// outside the project still see Robin's MCP. The project-local invariant
// is the source of truth for actual function.
//
// We accept the race with Claude Code's own writer: it rewrites the file
// from its in-memory copy without locking. Our tmpfile-rename can still
// clobber unrelated changes. This is intentionally warn-level, not critical.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readConfig } from '../../config/paths.js';
import { canonicalEntry } from './mcp.wiring-project-present.js';

const ROBIN_KEY = 'robin';

function globalClaudeJsonPath() {
  return join(homedir(), '.claude.json');
}

async function readPort() {
  const cfg = await readConfig().catch(() => null);
  const v = cfg?.mcp?.port;
  return Number.isInteger(v) && v > 0 ? v : null;
}

function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(p, payload) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

export default {
  name: 'mcp.wiring_global_present',
  level: 'warn',
  surface: 'mcp',
  phase: 'mcp',
  description: 'Global ~/.claude.json has the robin SSE entry (convenience; project-local entry is the source of truth).',

  runWhen: {
    boot: { enabled: false },
    heartbeat: { enabled: true, cooldownMs: 5 * 60 * 1000 },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },

  async check() {
    const p = globalClaudeJsonPath();
    const port = await readPort();
    if (port == null) return { ok: false, error: 'no_configured_port' };
    if (!existsSync(p)) return { ok: false, error: 'file_missing', evidence: { path: p } };
    const parsed = readJson(p);
    if (!parsed) return { ok: false, error: 'unparseable' };
    const entry = parsed?.mcpServers?.[ROBIN_KEY];
    if (!entry) return { ok: false, error: 'robin_entry_missing' };
    if (entry.type !== 'sse') return { ok: false, error: 'wrong_type', evidence: { type: entry.type } };
    const wantUrl = canonicalEntry(port).url;
    if (entry.url !== wantUrl) {
      return { ok: false, error: 'url_mismatch', evidence: { have: entry.url, want: wantUrl } };
    }
    return { ok: true, evidence: { url: entry.url } };
  },

  async repair(ctx) {
    const p = globalClaudeJsonPath();
    const port = await readPort();
    if (port == null) return { repaired: false, error: 'no_configured_port' };
    const existing = readJson(p) ?? {};
    const next = {
      ...existing,
      mcpServers: { ...(existing.mcpServers ?? {}), [ROBIN_KEY]: canonicalEntry(port) },
    };
    if (ctx?.dryRun) {
      return { repaired: false, action: 'would_write_global_claude_json', plan: { path: p, port } };
    }
    try {
      writeAtomic(p, next);
      return { repaired: true, action: 'wrote_global_claude_json', evidence: { path: p, port } };
    } catch (e) {
      return { repaired: false, error: e.message ?? 'write_failed' };
    }
  },

  explain(lastResult) {
    const lines = [
      '### `mcp.wiring_global_present`',
      '',
      '**Symptom.** Robin\'s MCP tools are absent in agent sessions launched outside the project directory.',
      '',
      '**Cause.** `~/.claude.json` has no `mcpServers.robin` entry, or the URL drifted from the daemon\'s configured port. Claude Code itself rewrites this file from an in-memory copy without locking, so an unrelated write can clobber Robin\'s entry.',
      '',
      '**Fix.** Invariant writes the canonical entry via read → modify → tmpfile-rename. We accept the race with Claude Code\'s writer because the project-local entry (`.mcp.json`) is the source of truth for in-project agents — this is best-effort convenience.',
      '',
      '**B-flag (B-2):** drop this invariant entirely once the project-local entry is verified sufficient for all relevant flows.',
    ];
    return lines.join('\n');
  },
};
