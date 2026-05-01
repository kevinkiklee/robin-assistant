import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { join } from 'node:path';
import { atomicWrite } from '../sync/markdown.js';
import { buildEntityRegistry } from './build-entity-registry.js';
import { computeSkipRanges, isInsideSkipRange, isExcludedPath } from './exclusions.js';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relPathFromTo(fromRelPath, toRelPath) {
  const fromDir = posix.dirname(fromRelPath);
  return posix.relative(fromDir, toRelPath);
}

function bodyAlreadyLinksTarget(body, fromRelPath, targetRelPath) {
  const linkRe = /\[[^\]]*\]\(([^)]*)\)/g;
  let m;
  while ((m = linkRe.exec(body)) !== null) {
    const target = m[1];
    if (target.startsWith('http') || target.startsWith('#')) continue;
    const fromDir = posix.dirname(fromRelPath);
    const resolved = posix.normalize(posix.join(fromDir, target));
    if (resolved === targetRelPath) return true;
  }
  return false;
}

export async function applyEntityLinks(workspaceDir, relPath, registry, opts = {}) {
  const errors = [];

  if (isExcludedPath(relPath)) {
    return { written: false, inserted: 0, skipped: [], errors };
  }

  let reg = registry;
  if (!reg) {
    try {
      reg = await buildEntityRegistry(workspaceDir);
    } catch (err) {
      return { written: false, inserted: 0, skipped: [], errors: [err.message], registryError: err.message };
    }
  }

  const fullPath = join(workspaceDir, 'user-data', 'memory', relPath);
  const original = await readFile(fullPath, 'utf-8');

  const ranges = computeSkipRanges(original);
  let body = original.normalize('NFC');
  const insertions = []; // { offset, length, replacement }

  for (const [, entry] of reg.byAlias) {
    if (entry.path === relPath) continue; // self-link skip
    if (bodyAlreadyLinksTarget(body, relPath, entry.path)) continue;

    // Find first plain-text occurrence of any alias for this entity (W1).
    let bestMatch = null;
    for (const alias of entry.aliases) {
      const re = new RegExp(`\\b${escapeRegex(alias.normalize('NFC'))}\\b`, 'iu');
      const m = re.exec(body);
      if (!m) continue;
      if (isInsideSkipRange(m.index, ranges)) continue;
      if (insertions.some(ins => m.index >= ins.offset && m.index < ins.offset + ins.length)) continue;
      if (!bestMatch || m.index < bestMatch.offset) {
        bestMatch = { offset: m.index, length: m[0].length, matchText: m[0], target: entry.path };
      }
    }

    if (bestMatch) {
      const rel = relPathFromTo(relPath, bestMatch.target);
      insertions.push({
        offset: bestMatch.offset,
        length: bestMatch.length,
        replacement: `[${bestMatch.matchText}](${rel})`,
      });
    }
  }

  if (insertions.length === 0) {
    return { written: false, inserted: 0, skipped: [], errors };
  }

  // Apply insertions back-to-front so offsets stay valid.
  insertions.sort((a, b) => b.offset - a.offset);
  let modified = body;
  for (const ins of insertions) {
    modified = modified.slice(0, ins.offset) + ins.replacement + modified.slice(ins.offset + ins.length);
  }

  if (opts.dryRun) {
    return { written: false, inserted: insertions.length, content: modified, skipped: [], errors };
  }

  await atomicWrite(workspaceDir, posix.join('user-data/memory', relPath), modified);
  return { written: true, inserted: insertions.length, skipped: [], errors };
}
