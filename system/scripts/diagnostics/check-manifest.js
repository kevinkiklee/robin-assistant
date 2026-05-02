#!/usr/bin/env node
// Cycle-2b: SessionStart drift detector.
//
// Compares current state (hooks in .claude/settings.json + loaded MCP servers)
// against the trusted manifest at user-data/runtime/security/manifest.json. Severe
// drift surfaces in stderr (visible in model context). Mild/info drift goes
// to policy-refusals.log for retrospective review in morning briefing.
//
// Fail-soft: missing manifest → warning + exit 0. Uncaught error → log
// + warning + exit 0 (we don't block sessions on a hook bug).

import { dirname, resolve, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadManifest, loadCurrentSettings, enumerateMCPServers } from '../lib/manifest.js';
import { appendPolicyRefusal, readRecentRefusalHashes } from '../lib/policy-refusals-log.js';
import { fnv1a64 } from '../sync/lib/untrusted-index.js';
import { hashHardRules } from '../lib/agentsmd-hash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const STDERR_BOUND = 5;  // collapse beyond this many entries.
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export function computeDrift(expected, currentSettings, currentMCP, opts = {}) {
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

  // Cycle-2c: AGENTS.md Hard Rules hash check.
  if (opts.agentsmdContent !== undefined) {
    const currentHash = hashHardRules(opts.agentsmdContent);
    if (currentHash === null) {
      drift.push({
        severity: 'severe',
        kind: 'agentsmd-hard-rules-missing',
        detail: 'Hard Rules section not found in AGENTS.md',
        hash: 'agentsmd-missing',
      });
    } else if (!expected.agentsmd?.hardRulesHash) {
      // First-run baseline missing — info only.
      drift.push({
        severity: 'info',
        kind: 'agentsmd-hard-rules-baseline-missing',
        detail: `Run manifest-snapshot.js to populate hardRulesHash (current=${currentHash.slice(0, 8)}…)`,
        hash: `baseline:${currentHash}`,
      });
    } else if (expected.agentsmd.hardRulesHash !== currentHash) {
      drift.push({
        severity: 'severe',
        kind: 'agentsmd-hard-rules-drift',
        detail: `Hard Rules hash mismatch (expected ${expected.agentsmd.hardRulesHash.slice(0, 8)}…, got ${currentHash.slice(0, 8)}…)`,
        hash: `agentsmd-drift:${currentHash}`,
      });
    }
  }

  // Cycle-2c: user-data/runtime/jobs/ override drift.
  if (opts.userDataJobsFiles !== undefined) {
    const known = new Set(expected.userDataJobs?.knownFiles ?? []);
    for (const f of opts.userDataJobsFiles) {
      if (!known.has(f)) {
        drift.push({
          severity: 'mild',
          kind: 'unexpected-job-override',
          detail: `user-data/runtime/jobs/${f}`,
          hash: fnv1a64(`job:${f}`),
        });
      }
    }
  }

  return drift;
}

function readAgentsMD(workspaceDir) {
  const p = join(workspaceDir, 'AGENTS.md');
  if (!existsSync(p)) return undefined;
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return undefined;
  }
}

function listUserDataJobs(workspaceDir) {
  const dir = join(workspaceDir, 'user-data/runtime/jobs');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
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
        'WARNING: user-data/runtime/security/manifest.json missing or malformed; tamper detection inactive. ' +
        'Run `node system/scripts/cli/setup.js` to bootstrap, or `node system/scripts/diagnostics/manifest-snapshot.js --apply --confirm-trust-current-state`.\n'
      );
      process.exit(0);
    }
    const currentSettings = loadCurrentSettings(workspaceDir);
    const currentMCP = enumerateMCPServers(workspaceDir);
    const agentsmdContent = readAgentsMD(workspaceDir);
    const userDataJobsFiles = listUserDataJobs(workspaceDir);
    const drift = computeDrift(manifest, currentSettings, currentMCP, { agentsmdContent, userDataJobsFiles });
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
