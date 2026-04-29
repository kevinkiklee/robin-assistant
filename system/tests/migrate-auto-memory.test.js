import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'system', 'scripts', 'migrate-auto-memory.js');

function runScript(args = []) {
  return execFileSync('node', [SCRIPT, ...args, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('migrate-auto-memory', () => {
  it('produces JSON shape with by_host', () => {
    const out = JSON.parse(runScript());
    assert.ok(out.by_host);
    assert.ok('claude-code' in out.by_host);
  });

  it('reports zero migrated when run twice in a row (idempotent)', () => {
    // First run drains anything; second run should be 0.
    runScript(['--apply']);
    const out = JSON.parse(runScript(['--apply']));
    assert.equal(out.migrated, 0);
  });

  it('does not modify inbox.md without --apply', () => {
    const inbox = join(REPO_ROOT, 'user-data', 'memory', 'inbox.md');
    const before = existsSync(inbox)
      ? execFileSync('wc', ['-c', inbox], { encoding: 'utf8' })
      : '';
    runScript();
    const after = existsSync(inbox)
      ? execFileSync('wc', ['-c', inbox], { encoding: 'utf8' })
      : '';
    assert.equal(before, after);
  });
});
