// mcp.wiring_project_present
//
// .mcp.json at the package root is the project-local MCP wiring. Claude Code
// reads it when running inside the project; without it, mcp__robin__* tools
// are not exposed to the agent.
//
// We write it ourselves (idempotent canonical entry). Project-local file =
// no race with other writers, unlike ~/.claude.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { packageRootDir } from '../../config/data-store.js';
import { readConfig } from '../../config/paths.js';

const ROBIN_KEY = 'robin';

function projectMcpPath() {
  return join(packageRootDir(), '.mcp.json');
}

async function readPort() {
  const cfg = await readConfig().catch(() => null);
  const v = cfg?.mcp?.port;
  return Number.isInteger(v) && v > 0 ? v : null;
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(p, payload) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
}

export function canonicalEntry(port) {
  return { type: 'sse', url: `http://127.0.0.1:${port}/sse` };
}

export default {
  name: 'mcp.wiring_project_present',
  level: 'critical',
  surface: 'mcp',
  phase: 'mcp',
  description: '.mcp.json at the package root exposes the robin MCP server to Claude Code.',

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 5 * 60 * 1000 },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },

  async check() {
    const p = projectMcpPath();
    const port = await readPort();
    if (port == null) return { ok: false, error: 'no_configured_port' };
    if (!existsSync(p)) return { ok: false, error: 'file_missing', evidence: { path: p } };
    const parsed = readJson(p);
    if (!parsed) return { ok: false, error: 'unparseable', evidence: { path: p } };
    const entry = parsed?.mcpServers?.[ROBIN_KEY];
    if (!entry) return { ok: false, error: 'robin_entry_missing', evidence: { path: p } };
    if (entry.type !== 'sse') {
      return { ok: false, error: 'wrong_type', evidence: { type: entry.type } };
    }
    const wantUrl = canonicalEntry(port).url;
    if (entry.url !== wantUrl) {
      return { ok: false, error: 'url_mismatch', evidence: { have: entry.url, want: wantUrl } };
    }
    return { ok: true, evidence: { url: entry.url } };
  },

  async repair(ctx) {
    const p = projectMcpPath();
    const port = await readPort();
    if (port == null) return { repaired: false, error: 'no_configured_port' };
    const existing = readJson(p) ?? {};
    const next = {
      ...existing,
      mcpServers: { ...(existing.mcpServers ?? {}), [ROBIN_KEY]: canonicalEntry(port) },
    };
    if (ctx?.dryRun) {
      return { repaired: false, action: 'would_write_project_mcp', plan: { path: p, port } };
    }
    try {
      writeAtomic(p, next);
      return { repaired: true, action: 'wrote_project_mcp', evidence: { path: p, port } };
    } catch (e) {
      return { repaired: false, error: e.message ?? 'write_failed' };
    }
  },

  explain(lastResult) {
    const lines = [
      '### `mcp.wiring_project_present`',
      '',
      '**Symptom.** `mcp__robin__*` tools do not appear in Claude Code; the agent has no way to call recall/remember/find_entity.',
      '',
      '**Cause.** Project-local `.mcp.json` is missing, malformed, or points at the wrong port. This is the *source of truth* for MCP wiring inside the project — global `~/.claude.json` is a separate, lower-priority concern.',
      '',
      '**Fix.** Invariant writes the canonical entry directly: `{"type": "sse", "url": "http://127.0.0.1:<port>/sse"}` where `<port>` comes from `runtime:config.mcp.port`.',
    ];
    if (lastResult?.evidence?.have && lastResult?.evidence?.want) {
      lines.push(
        '',
        `**URL mismatch:** have \`${lastResult.evidence.have}\` want \`${lastResult.evidence.want}\``,
      );
    }
    return lines.join('\n');
  },
};
