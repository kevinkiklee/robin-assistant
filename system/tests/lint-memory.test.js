import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'system', 'scripts', 'lint-memory.js');

function runLint() {
  try {
    const out = execFileSync('node', [SCRIPT, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString?.() ?? '';
    return { exitCode: e.status ?? 1, output: out ? JSON.parse(out) : { issues: [] } };
  }
}

describe('lint-memory', () => {
  it('passes on the current memory tree', () => {
    const { exitCode, output } = runLint();
    assert.equal(exitCode, 0, `Lint failed: ${JSON.stringify(output.issues, null, 2)}`);
  });

  it('reports issues array', () => {
    const { output } = runLint();
    assert.ok(Array.isArray(output.issues));
  });
});
