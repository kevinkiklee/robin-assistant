#!/usr/bin/env node
// densify-wiki.js — orchestrator entrypoint for the densify-wiki Phase 1 sweep.
// This file holds argv parsing, pass-marker management, first-run detection,
// and (in Task 17) the sentinel cap. The full run loop wiring all 4 passes
// is added in Task 18.

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireDensifyLock, releaseDensifyLock } from './lib/densify-lock.js';
import { expandAliases } from './lib/alias-expander.js';
import { runRelatedHeuristic } from './lib/related-heuristic.js';
import { writeRunReport } from './lib/densify-report.js';
import { runBackfill } from './backfill-entity-links.js';
import { findMissingAliases, findTypeMismatches, findStaleRelated } from './lint.js';

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
      `Run with --dry-run first to preview, then either restore from backup and tune ` +
      `the heuristic threshold, or accept the changes by raising the cap in code.`
    );
  }
}

const STOPLIST_PATH = join(__dirname, 'lib', 'alias-stoplist.json');

function loadStopList() {
  return new Set(JSON.parse(readFileSync(STOPLIST_PATH, 'utf-8')).map(s => s.toLowerCase()));
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function findLatestBackup(workspaceDir) {
  const dir = join(workspaceDir, 'backup');
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir).filter(f => f.startsWith('user-data-'));
  if (entries.length === 0) return null;
  entries.sort();
  return join('backup', entries[entries.length - 1]);
}

function runBackupCli(workspaceDir) {
  const r = spawnSync('npm', ['run', 'backup'], { cwd: workspaceDir, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`backup failed (exit ${r.status})`);
  return findLatestBackup(workspaceDir);
}

export async function runDensifyWiki({ workspaceDir, mode = 'dry-run', skipBackup = false, opts = {} }) {
  const apply = mode === 'apply' || mode === 'resume';
  const dryRun = !apply;
  const date = todayDate();
  const errors = [];
  const passes = {};
  let lock = null;
  let backupPath = null;

  if (mode === 'restart') clearPassMarkers(workspaceDir);
  const markers = mode === 'resume' ? readPassMarkers(workspaceDir) : {};

  try {
    if (apply && !skipBackup) {
      backupPath = runBackupCli(workspaceDir);
    }
    if (apply) {
      lock = acquireDensifyLock(workspaceDir);
    }

    const stopList = loadStopList();

    // Pre-Pass 0 — count existing service-provider stubs.
    const stubsDir = join(workspaceDir, 'user-data/memory/knowledge/service-providers');
    let stubsCreated = 0;
    if (existsSync(stubsDir)) {
      stubsCreated = readdirSync(stubsDir).filter(f => f.endsWith('.md')).length;
    }
    passes.prePass0 = { stubsCreated };

    // Pass 1 — alias expansion
    if (markers[1] !== 'done') {
      try {
        const r = await expandAliases({ workspaceDir, stopList, dryRun });
        passes.pass1 = {
          aliasesAdded: r.summary.aliasesAdded,
          typeFlips: r.summary.typeFlips,
          perFile: r.perFile,
          rejections: r.summary.rejections,
        };
        if (apply) writePassMarker(workspaceDir, 1, 'done');
      } catch (e) {
        errors.push(`Pass 1: ${e.message}`);
        if (apply) writePassMarker(workspaceDir, 1, 'failed');
        throw e;
      }
    }

    // Sentinel cap check after Pass 1 (only when applying).
    if (apply) {
      const cap = computeSentinelCap(workspaceDir);
      const estimate = (passes.pass1?.aliasesAdded ?? 0) + (passes.pass1?.typeFlips ?? 0);
      validateAgainstCap(estimate, cap);
    }

    // Pass 2 — linker backfill (returns { reportDir, totalInserted, filesTouched }).
    if (markers[2] !== 'done') {
      try {
        const r = await runBackfill({ workspaceDir, scope: 'all', apply, reportDir: undefined });
        // filesTouched from runBackfill is a number count, not an array.
        passes.pass2 = {
          linksInserted: r?.totalInserted ?? 0,
          filesTouchedCount: r?.filesTouched ?? 0,
          perFile: [],
        };
        if (apply) writePassMarker(workspaceDir, 2, 'done');
      } catch (e) {
        errors.push(`Pass 2: ${e.message}`);
        if (apply) writePassMarker(workspaceDir, 2, 'failed');
        throw e;
      }
    }

    // Pass 3 — related: heuristic.
    if (markers[3] !== 'done') {
      try {
        const r = await runRelatedHeuristic({
          workspaceDir,
          threshold: opts.relatedThreshold ?? 3,
          topK: opts.topK ?? 5,
          totalCap: opts.totalCap ?? 10,
          superhubPct: opts.superhubPct ?? 0.05,
          dryRun,
        });
        passes.pass3 = r.summary;
        if (apply) writePassMarker(workspaceDir, 3, 'done');
      } catch (e) {
        errors.push(`Pass 3: ${e.message}`);
        if (apply) writePassMarker(workspaceDir, 3, 'failed');
        throw e;
      }
    }

    // Pass 4 — index regen (apply mode only). index-entities.js is CLI-only,
    // invoked via subprocess. writeLinksIndex(memoryDir, workspaceDir) and
    // writeMemoryIndex(memoryDir) are exported as functions.
    if (apply && markers[4] !== 'done') {
      try {
        const memoryDir = join(workspaceDir, 'user-data', 'memory');
        const { writeLinksIndex } = await import('./regenerate-links.js');
        const { writeMemoryIndex } = await import('./regenerate-index.js');
        const indexEntitiesScript = join(__dirname, 'index-entities.js');
        const regen = spawnSync('node', [indexEntitiesScript, '--regenerate'],
          { cwd: workspaceDir, stdio: 'inherit' });
        // Exit 0 = ok; exit 2 = user-edited ENTITIES.md, skipped (acceptable).
        if (regen.status !== 0 && regen.status !== 2) {
          throw new Error(`index-entities --regenerate failed (exit ${regen.status})`);
        }
        writeLinksIndex(memoryDir, workspaceDir);
        writeMemoryIndex(memoryDir);
        passes.pass4 = { entitiesDelta: 0, linksDelta: 0 };  // Deltas left to follow-up.
        writePassMarker(workspaceDir, 4, 'done');
      } catch (e) {
        errors.push(`Pass 4: ${e.message}`);
        writePassMarker(workspaceDir, 4, 'failed');
        throw e;
      }
    }

    // Lint scan (always runs).
    passes.lint = {
      missingAliases: findMissingAliases(workspaceDir).map(f => f.file),
      typeMismatch: findTypeMismatches(workspaceDir).map(f => f.file),
      staleRelated: findStaleRelated(workspaceDir).map(f => f.file),
      ambiguousAliases: [],
      candidateEntities: [],
    };

    const written = writeRunReport({ workspaceDir, date, mode, backupPath, passes, errors });
    return {
      exitCode: 0,
      summaryPath: written.jsonPath,
      reportPath: written.markdownPath,
      summary: passes,
    };
  } catch (err) {
    if (!errors.includes(err.message)) errors.push(err.message);
    const written = writeRunReport({ workspaceDir, date, mode, backupPath, passes, errors });
    return {
      exitCode: 1,
      summaryPath: written.jsonPath,
      reportPath: written.markdownPath,
      summary: passes,
    };
  } finally {
    if (lock) releaseDensifyLock(lock);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgv(process.argv.slice(2));
  runDensifyWiki({ workspaceDir: REPO_ROOT, mode: args.mode })
    .then(r => {
      console.log(`exit=${r.exitCode}`);
      console.log(`report: ${r.reportPath}`);
      console.log(`summary: ${r.summaryPath}`);
      process.exit(r.exitCode);
    })
    .catch(e => { console.error(e); process.exit(1); });
}
