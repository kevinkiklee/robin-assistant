#!/usr/bin/env node
// Lints markdown files for stale `system/...` path references.
// Skips: node_modules, .git, docs/superpowers, system/migrations, CHANGELOG.md, user-data.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCAN_EXTENSIONS = ['.md'];
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'user-data',
  '.worktrees',
  '.superpowers',
  'docs',
]);
const SKIP_REL_DIRS = ['docs/superpowers', 'system/migrations'];
const SKIP_FILES = new Set(['CHANGELOG.md']);
const PATH_RE = /`(system\/[A-Za-z0-9._/-]+)`/g;

function shouldSkipDir(rel) {
  return SKIP_REL_DIRS.some((p) => rel === p || rel.startsWith(p + '/'));
}

function walkMarkdown(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (shouldSkipDir(rel)) continue;
      walkMarkdown(root, full, out);
    } else if (SCAN_EXTENSIONS.some((e) => entry.name.endsWith(e))) {
      if (SKIP_FILES.has(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

export function findStalePaths(root) {
  const issues = [];
  for (const file of walkMarkdown(root)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      const re = new RegExp(PATH_RE.source, 'g');
      while ((m = re.exec(line)) !== null) {
        const ref = m[1].replace(/\/$/, '');
        if (!existsSync(join(root, ref))) {
          issues.push({ file: relative(root, file), line: i + 1, path: m[1] });
        }
      }
    }
  }
  return issues;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const issues = findStalePaths(root);
  if (issues.length === 0) {
    console.log('No stale system/ path references.');
    process.exit(0);
  }
  for (const issue of issues) {
    console.error(`${issue.file}:${issue.line}: stale ref to ${issue.path}`);
  }
  process.exit(1);
}
