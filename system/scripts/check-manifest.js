#!/usr/bin/env node
// Cycle-2b: SessionStart drift detector.
//
// Compares current state (hooks in .claude/settings.json + loaded MCP servers)
// against the trusted manifest at user-data/security/manifest.json. Severe
// drift surfaces in stderr (visible in model context). Mild/info drift goes
// to policy-refusals.log for retrospective review in morning briefing.
//
// Fail-soft: missing manifest → warning + exit 0. Uncaught error → log
// + warning + exit 0 (we don't block sessions on a hook bug).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, loadCurrentSettings, enumerateMCPServers } from './lib/manifest.js';
import { appendPolicyRefusal, readRecentRefusalHashes } from './lib/policy-refusals-log.js';
import { fnv1a64 } from './lib/sync/untrusted-index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const STDERR_BOUND = 5;  // collapse beyond this many entries.
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export function computeDrift(expected, currentSettings, currentMCP) {
  const drift = [];
  const settings = currentSettings ?? { hooks: {} };

  // Hooks: any current hook command that isn't in the manifest → severe.
  for (const [event, hooks] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(hooks)) continue;
    const expectedHooks = expected.hooks?.[event] ?? [];
    for (const hook of hooks) {
      // settings.json shape: { matcher?, hooks: [{type,command}] }
      const inner = hook.hooks ?? [hook];
      for (const h of inner) {
        const cmd = h.command;
        if (!cmd) continue;
        const match = expectedHooks.some((e) =>
          (e.matcher ?? null) === (hook.matcher ?? null) && e.command === cmd
        );
        if (!match) {
          drift.push({
            severity: 'severe',
            kind: 'unexpected-hook',
            detail: `${event}/${hook.matcher ?? '*'}: ${cmd}`,
            hash: fnv1a64(`hook:${event}:${hook.matcher ?? '*'}:${cmd}`),
          });
        }
      }
    }
  }

  // MCP servers: any current MCP not in expected → mild OR severe.
  for (const mcp of currentMCP) {
    if (!(expected.mcpServers?.expected ?? []).includes(mcp)) {
      const isWriteCapable = (expected.mcpServers?.writeCapable ?? []).includes(mcp);
      drift.push({
        severity: isWriteCapable ? 'severe' : 'mild',
        kind: 'unexpected-mcp',
        detail: `${mcp}${isWriteCapable ? ' (write-capable)' : ''}`,
        hash: fnv1a64(`mcp:${mcp}`),
      });
    }
  }

  return drift;
}

export function emitDrift(workspaceDir, drift) {
  if (drift.length === 0) return;
  const severe = drift.filter((d) => d.severity === 'severe');
  const mild = drift.filter((d) => d.severity === 'mild');

  // Stderr surface — bounded.
  if (severe.length > 0 && severe.length <= STDERR_BOUND) {
    for (const d of severe) {
      process.stderr.write(`TAMPER DRIFT [severe]: ${d.kind} - ${d.detail}\n`);
    }
  } else if (severe.length > STDERR_BOUND) {
    process.stderr.write(`TAMPER DRIFT [severe]: ${severe.length} entries — see policy-refusals.log\n`);
  }
  if (mild.length > STDERR_BOUND) {
    process.stderr.write(`TAMPER DRIFT [mild]: ${mild.length} entries — see policy-refusals.log\n`);
  }
  // ≤5 mild entries: silent at session start; morning briefing surfaces.

  // Refusal log — deduped 24h.
  const recent = readRecentRefusalHashes(workspaceDir, 'tamper', DEDUP_WINDOW_MS);
  for (const d of drift) {
    if (recent.has(d.hash)) continue;
    appendPolicyRefusal(workspaceDir, {
      kind: 'tamper',
      target: d.kind,
      layer: d.severity,
      reason: d.detail,
      contentHash: d.hash,
    });
  }
}

async function main() {
  const workspaceDir = process.env.ROBIN_WORKSPACE || REPO_ROOT;
  try {
    const manifest = loadManifest(workspaceDir);
    if (!manifest) {
      process.stderr.write(
        'WARNING: user-data/security/manifest.json missing or malformed; tamper detection inactive. ' +
        'Run `node system/scripts/setup.js` to bootstrap, or `node system/scripts/manifest-snapshot.js --apply --confirm-trust-current-state`.\n'
      );
      process.exit(0);
    }
    const currentSettings = loadCurrentSettings(workspaceDir);
    const currentMCP = enumerateMCPServers(workspaceDir);
    const drift = computeDrift(manifest, currentSettings, currentMCP);
    emitDrift(workspaceDir, drift);
    process.exit(0);
  } catch (err) {
    // Fail-soft for SessionStart — log but don't block session.
    try {
      appendPolicyRefusal(workspaceDir, {
        kind: 'tamper',
        target: 'hook',
        layer: 'hook-internal-error',
        reason: `HOOK_INTERNAL_ERROR: ${err?.message || String(err)}`,
        contentHash: '',
      });
    } catch { /* nested logging failure ignored */ }
    process.stderr.write(`TAMPER CHECK FAILED: ${err?.message || String(err)}\n`);
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
