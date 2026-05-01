#!/usr/bin/env node
// Cycle-2c migration — runs once after deployment.
//
// 1. Walks user-data/memory/self-improvement/patterns.md and seeds
//    last_fired (today) + fired_count (0) for any pattern lacking those
//    frontmatter fields. Without this, the first Dream TTL pass would
//    archive every pattern (last_fired = "never" → infinite age).
// 2. Bumps user-data/security/manifest.json from v1 → v2 (adds
//    agentsmd + userDataJobs fields with empty values).
//
// Idempotent: rerunnable. Patterns already carrying last_fired stay put.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function migratePatterns(workspaceDir) {
  const path = join(workspaceDir, 'user-data/memory/self-improvement/patterns.md');
  if (!existsSync(path)) return { stamped: 0, reason: 'no-patterns-file' };
  const content = readFileSync(path, 'utf-8');
  if (!content.includes('## ')) return { stamped: 0, reason: 'no-patterns' };

  const today = todayISO();
  const parts = content.split(/^## /m);
  const preamble = parts.shift();
  let stamped = 0;
  const out = [preamble];
  for (const block of parts) {
    let next = '## ' + block;
    const fmRe = /^## ([^\n]+)\n---\n([\s\S]*?)\n---\n/;
    const m = next.match(fmRe);
    if (m) {
      const title = m[1];
      const fmInner = m[2];
      const additions = [];
      if (!/^last_fired:/m.test(fmInner)) additions.push(`last_fired: ${today}`);
      if (!/^fired_count:/m.test(fmInner)) additions.push('fired_count: 0');
      if (additions.length > 0) {
        const newFm = fmInner + '\n' + additions.join('\n');
        next = `## ${title}\n---\n${newFm}\n---\n` + next.slice(m[0].length);
        stamped += 1;
      }
    }
    out.push(next);
  }
  const newContent = out.join('');
  if (stamped > 0) writeFileSync(path, newContent);
  return { stamped };
}

function migrateManifestV2(workspaceDir) {
  const p = join(workspaceDir, 'user-data/security/manifest.json');
  if (!existsSync(p)) return { migrated: false, reason: 'no-manifest' };
  let data;
  try {
    data = JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return { migrated: false, reason: 'malformed' };
  }
  let mutated = false;
  if (data.version !== 2) { data.version = 2; mutated = true; }
  if (!data.agentsmd) { data.agentsmd = { hardRulesHash: '', lastSnapshot: '' }; mutated = true; }
  if (!data.userDataJobs) { data.userDataJobs = { knownFiles: [] }; mutated = true; }
  if (mutated) writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  return { migrated: mutated };
}

export function migrateCycle2c(workspaceDir) {
  return {
    patterns: migratePatterns(workspaceDir),
    manifest: migrateManifestV2(workspaceDir),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceDir = process.env.ROBIN_WORKSPACE || REPO_ROOT;
  const r = migrateCycle2c(workspaceDir);
  console.log('[migrate-cycle-2c] patterns stamped:', r.patterns.stamped ?? 0, 'manifest migrated:', r.manifest.migrated);
  process.exit(0);
}
