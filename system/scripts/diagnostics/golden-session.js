#!/usr/bin/env node
// Golden-session snapshot: captures host-agnostic Tier 1 expected loads.
//
// Source of truth: token-budget.json (tier1_files). This script writes a
// snapshot file that CI compares against. Updates require an explicit flag
// AND a CHANGELOG entry (the latter enforced by reviewer; the former by
// this script).
//
// Modes:
//   --check               compare current state to golden; exit 1 on diff
//   --update-snapshot     overwrite the snapshot (requires CHANGELOG entry; honor system)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const BUDGET_PATH = join(REPO_ROOT, 'system', 'scripts', 'diagnostics', 'lib', 'token-budget.json');
const SNAPSHOT_PATH = join(REPO_ROOT, 'system', 'tests', 'capture', 'golden-session.snapshot.json');

function buildSnapshot() {
  const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
  return {
    schema_version: 1,
    tier1_load_order: budget.tier1_files.map((f) => ({
      path: f.path,
      stability: f.stability,
      required: f.required === true,
      optional_existence: f.optional_existence === true,
    })),
    stability_order: budget.stability_order,
    invariants: {
      capture_checkpoint_in_agents_md: true,
      hard_rules_in_agents_md: true,
      tier2_pointer_table_in_agents_md: true,
      archive_index_referenced: true,
    },
  };
}

function readSnapshot() {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
}

function diff(current, golden) {
  if (golden === null) return ['No golden snapshot exists. Run with --update-snapshot.'];
  const issues = [];
  if (golden.schema_version !== current.schema_version) {
    issues.push(`schema_version drift: ${golden.schema_version} → ${current.schema_version}`);
  }
  // Compare tier1 load order
  const goldenPaths = golden.tier1_load_order.map((e) => e.path).join(',');
  const currentPaths = current.tier1_load_order.map((e) => e.path).join(',');
  if (goldenPaths !== currentPaths) {
    issues.push('tier1 load order or membership changed');
    issues.push(`  golden: ${goldenPaths}`);
    issues.push(`  current: ${currentPaths}`);
  }
  // Compare stability assignments
  const goldenStab = JSON.stringify(golden.tier1_load_order.map((e) => `${e.path}:${e.stability}`));
  const currentStab = JSON.stringify(current.tier1_load_order.map((e) => `${e.path}:${e.stability}`));
  if (goldenStab !== currentStab) {
    issues.push('tier1 stability classification changed');
  }
  return issues;
}

function main() {
  const update = process.argv.includes('--update-snapshot');
  const check = process.argv.includes('--check');
  const current = buildSnapshot();

  if (update) {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + '\n');
    console.log(`Snapshot written to ${SNAPSHOT_PATH}`);
    console.log('Reminder: include a CHANGELOG entry justifying this change.');
    process.exit(0);
  }

  const golden = readSnapshot();
  const issues = diff(current, golden);
  if (issues.length === 0) {
    if (check) console.log('Golden-session snapshot matches.');
    process.exit(0);
  }
  console.error('Golden-session snapshot drift:');
  for (const i of issues) console.error(`  ${i}`);
  console.error('');
  console.error('If this change is intentional, run:');
  console.error('  npm run golden-session -- --update-snapshot');
  console.error('and add a CHANGELOG entry describing why Tier 1 changed.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
