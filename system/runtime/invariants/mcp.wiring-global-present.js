// mcp.wiring_global_present
//
// ~/.claude.json's mcpServers.robin entry is convenience — agents running
// outside the project still see Robin's MCP. The project-local invariant
// is the source of truth for actual function.
//
// B-2 applied: detection only. The previous version wrote the entry on
// repair, which raced with Claude Code's own writer (it rewrites the file
// from an in-memory copy without locking). Surfacing the drift here is
// enough — the user can re-add the entry manually if they care, and
// project-local `.mcp.json` covers in-project sessions either way.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export default {
  name: 'mcp.wiring_global_present',
  level: 'warn',
  surface: 'mcp',
  phase: 'mcp',
  description:
    'Global ~/.claude.json has the robin SSE entry (convenience; project-local entry is the source of truth).',

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
    if (entry.type !== 'sse')
      return { ok: false, error: 'wrong_type', evidence: { type: entry.type } };
    const wantUrl = canonicalEntry(port).url;
    if (entry.url !== wantUrl) {
      return { ok: false, error: 'url_mismatch', evidence: { have: entry.url, want: wantUrl } };
    }
    return { ok: true, evidence: { url: entry.url } };
  },

  // B-2 applied: no repair function. The previous repair wrote
  // ~/.claude.json's robin entry but raced with Claude Code's writer.
  // Detection-only surfaces the drift; project-local .mcp.json covers
  // in-project sessions, which is where Robin's tools matter.

  explain(_lastResult) {
    const lines = [
      '### `mcp.wiring_global_present`',
      '',
      "**Symptom.** Robin's MCP tools are absent in agent sessions launched outside the project directory.",
      '',
      "**Cause.** `~/.claude.json` has no `mcpServers.robin` entry, or the URL drifted from the daemon's configured port. Claude Code itself rewrites this file from an in-memory copy without locking, so an unrelated write can clobber Robin's entry.",
      '',
      '**Fix (manual).** Add the entry by hand:',
      '```json',
      '{ "mcpServers": { "robin": { "type": "sse", "url": "http://127.0.0.1:<port>/sse" } } }',
      '```',
      'Port lives in `runtime:config.mcp.port`. The project-local `.mcp.json` covers in-project sessions; this entry only matters for agent sessions launched outside the project.',
    ];
    return lines.join('\n');
  },
};
