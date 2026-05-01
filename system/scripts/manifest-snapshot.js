#!/usr/bin/env node
// Cycle-2b: snapshot helper for the tamper-detection manifest.
//
// Default mode (read-only):
//   node system/scripts/manifest-snapshot.js
//   → writes a manifest-shaped JSON dump of the current state to stdout.
//   Useful for diff against the live manifest before manual edit.
//
// First-deploy bootstrap (overwrites live manifest):
//   node system/scripts/manifest-snapshot.js --apply --confirm-trust-current-state
//   → writes the snapshot to user-data/security/manifest.json.
//   Two-flag pattern; `--apply` alone exits 1 with explanation.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeManifest, loadCurrentSettings, enumerateMCPServers } from './lib/manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function buildSnapshot(workspaceDir) {
  const settings = loadCurrentSettings(workspaceDir);
  // Convert .claude/settings.json hook shape to manifest hook shape.
  // settings.json shape: hooks.<Event>: [{ matcher?, hooks: [{type,command}] }]
  // manifest shape:      hooks.<Event>: [{ matcher?, command }]
  const hooks = {};
  for (const [event, entries] of Object.entries(settings?.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    const out = [];
    for (const e of entries) {
      const inner = e.hooks ?? [e];
      for (const h of inner) {
        if (!h.command) continue;
        const row = { command: h.command };
        if (e.matcher !== undefined) row.matcher = e.matcher;
        out.push(row);
      }
    }
    if (out.length > 0) hooks[event] = out;
  }

  const mcpExpected = enumerateMCPServers(workspaceDir);

  return {
    version: 1,
    hooks,
    mcpServers: {
      expected: mcpExpected,
      writeCapable: [],
    },
  };
}

function parseArgs(argv) {
  const args = { apply: false, confirm: false };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--confirm-trust-current-state') args.confirm = true;
  }
  return args;
}

export { buildSnapshot };

async function main() {
  const workspaceDir = process.env.ROBIN_WORKSPACE || REPO_ROOT;
  const args = parseArgs(process.argv);
  const snapshot = buildSnapshot(workspaceDir);

  if (args.apply && !args.confirm) {
    process.stderr.write(
      'manifest-snapshot.js --apply requires --confirm-trust-current-state to proceed.\n' +
      'This overwrites user-data/security/manifest.json with current state, which\n' +
      'accepts whatever is currently registered as trusted. Use only after reviewing.\n'
    );
    process.exit(1);
  }

  if (args.apply) {
    writeManifest(workspaceDir, snapshot);
    process.stderr.write('manifest-snapshot.js: wrote user-data/security/manifest.json\n');
    process.exit(0);
  }

  process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
