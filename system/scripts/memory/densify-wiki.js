#!/usr/bin/env node
// densify-wiki.js — orchestrator entrypoint for the densify-wiki Phase 1 sweep.
// This file holds argv parsing, pass-marker management, first-run detection,
// and (in Task 17) the sentinel cap. The full run loop wiring all 4 passes
// is added in Task 18.

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// densify-wiki.js lives at system/scripts/memory/densify-wiki.js, so REPO_ROOT
// is three levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..');

export function parseArgv(argv) {
  if (argv.includes('--apply')) return { mode: 'apply' };
  if (argv.includes('--restart')) return { mode: 'restart' };
  if (argv.includes('--resume')) return { mode: 'resume' };
  return { mode: 'dry-run' };
}

function markersDir(workspaceDir) {
  return join(workspaceDir, 'user-data', 'ops', 'state', 'densify-wiki');
}

export function writePassMarker(workspaceDir, n, kind) {
  const dir = markersDir(workspaceDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `.pass-${n}-${kind}`);
  writeFileSync(path, '');
}

export function readPassMarkers(workspaceDir) {
  const dir = markersDir(workspaceDir);
  if (!existsSync(dir)) return {};
  const out = {};
  for (const entry of readdirSync(dir)) {
    const m = entry.match(/^\.pass-(\d+)-(done|failed)$/);
    if (m) out[Number(m[1])] = m[2];
  }
  return out;
}

export function clearPassMarkers(workspaceDir) {
  const dir = markersDir(workspaceDir);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (/^\.pass-\d+-(done|failed)$/.test(entry)) {
      unlinkSync(join(dir, entry));
    }
  }
}

export function detectFirstRun(workspaceDir) {
  const dir = markersDir(workspaceDir);
  if (!existsSync(dir)) return true;
  for (const entry of readdirSync(dir)) {
    if (/^\d{4}-\d{2}-\d{2}\.md$/.test(entry)) return false;
  }
  return true;
}

export function computeSentinelCap(workspaceDir) {
  return detectFirstRun(workspaceDir) ? 250 : 50;
}

export function validateAgainstCap(estimate, cap) {
  if (estimate > cap) {
    throw new Error(
      `too many changes: estimate ${estimate} exceeds cap ${cap}. ` +
      `Chunk by --only-pass=N or fix the heuristic threshold (e.g., raise --related-threshold).`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI invocation; full orchestrator is wired in Task 18.
  console.log('densify-wiki orchestrator skeleton — full pipeline lands in Task 18.');
}
