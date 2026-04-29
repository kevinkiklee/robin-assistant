import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'system', 'scripts', 'golden-session.js');
const SNAPSHOT = join(REPO_ROOT, 'system', 'tests', 'golden-session.snapshot.json');

describe('golden-session', () => {
  it('snapshot exists', () => {
    assert.ok(existsSync(SNAPSHOT));
  });

  it('snapshot is valid JSON with expected shape', () => {
    const obj = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    assert.equal(obj.schema_version, 1);
    assert.ok(Array.isArray(obj.tier1_load_order));
    assert.ok(Array.isArray(obj.stability_order));
  });

  it('--check passes when current state matches snapshot', () => {
    const out = execFileSync('node', [SCRIPT, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.ok(typeof out === 'string');
  });
});
