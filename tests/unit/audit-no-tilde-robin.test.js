import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCAN_DIRS = ['src', 'scripts'];
const ALLOW_FILES = new Set([
  join(ROOT, 'src/cli/commands/install.js'),
  join(ROOT, 'src/migrate-v1/v1-client.js'),
]);

const PATTERNS = [/~\/\.robin\b/, /\/\.robin\//, /homedir\(\)\s*,\s*['"]\.robin['"]/];

function walk(dir, out = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('no source file outside allow-list mentions ~/.robin or /.robin/', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const hits = [];
  for (const f of files) {
    if (ALLOW_FILES.has(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const re of PATTERNS) {
      if (re.test(src)) {
        hits.push(`${f}: matched ${re}`);
      }
    }
  }
  assert.deepStrictEqual(hits, [], `forbidden ~/.robin references:\n${hits.join('\n')}`);
});
