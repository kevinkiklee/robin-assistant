import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCAN_DIRS = ['runtime', 'data', 'cognition', 'io', 'config'];
const ALLOW_FILES = new Set([
  join(ROOT, 'config/data-store.js'),
  join(ROOT, 'runtime/cli/commands/install.js'),
  join(ROOT, 'runtime/install/postinstall.js'),
  join(ROOT, 'migrate-v1/v1-client.js'),
  join(ROOT, 'cognition/discretion/bash-patterns.js'),
]);

const CONSTRUCTION_PATTERNS = [
  /join\([^)]*['"]user-data['"]/,
  /path\.resolve\([^)]*['"]user-data['"]/,
];

function walk(dir, out = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('only allow-listed files may construct paths with the user-data literal', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const hits = [];
  for (const f of files) {
    if (ALLOW_FILES.has(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const re of CONSTRUCTION_PATTERNS) {
      if (re.test(src)) hits.push(`${f}: matched ${re}`);
    }
  }
  assert.deepStrictEqual(hits, [], `forbidden user-data path construction:\n${hits.join('\n')}`);
});
