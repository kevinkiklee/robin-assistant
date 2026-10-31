import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { test } from 'node:test';

const CONFIG_EXTS = new Set(['.yaml', '.yml', '.json', '.env', '.toml', '.ini']);
// Files explicitly allowed under system/ despite having a config-shaped extension:
// framework manifests the runtime loaders read by fixed name.
const ALLOWED_BASENAMES = new Set<string>(['integration.yaml', 'job.yaml']);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

test('boundary: no config files under system/', () => {
  const files = walk('system');
  const violations: string[] = [];
  for (const f of files) {
    if (CONFIG_EXTS.has(extname(f)) && !ALLOWED_BASENAMES.has(basename(f))) {
      violations.push(f);
    }
  }
  assert.equal(violations.length, 0, `Config files found under system/: ${violations.join(', ')}`);
});
