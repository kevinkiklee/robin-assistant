// Tests for startup-check.js deprecation shim.
// The shim must still return the same shape as runPreflight and emit a
// deprecation warning to stderr on the first call per process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStartupCheck } from '../scripts/startup-check.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function repo(populated = true) {
  const root = mkdtempSync(join(tmpdir(), 'robin-su-'));
  mkdirSync(join(root, 'system/scaffold/memory/profile'), { recursive: true });
  mkdirSync(join(root, 'system/migrations'));
  writeFileSync(join(root, 'system/scaffold/memory/profile/identity.md'),
    '---\ndescription: Identity\n---\n# Identity\n');
  writeFileSync(join(root, 'system/scaffold/memory/INDEX.md'), '# Memory Index\n');
  writeFileSync(join(root, 'system/scaffold/robin.config.json'), '{"version":"3.0.0"}');
  writeFileSync(join(root, 'system/CHANGELOG.md'), '## [3.0.0]\n');
  if (populated) {
    mkdirSync(join(root, 'user-data/memory/profile'), { recursive: true });
    writeFileSync(join(root, 'user-data/memory/profile/identity.md'),
      '---\ndescription: Identity\n---\n# Identity\n');
    writeFileSync(join(root, 'user-data/memory/INDEX.md'), '# Memory Index\n');
    writeFileSync(join(root, 'user-data/robin.config.json'), '{"version":"3.0.0"}');
  }
  return root;
}

test('shim: runStartupCheck returns FATAL when user-data/ missing', async () => {
  const root = repo(false);
  const result = await runStartupCheck(root);
  assert.ok(result.findings.some(f => f.level === 'FATAL'));
  rmSync(root, { recursive: true, force: true });
});

test('shim: runStartupCheck auto-copies new scaffold files to user-data', async () => {
  const root = repo(true);
  writeFileSync(join(root, 'system/scaffold/health.md'), '# Health\n');
  await runStartupCheck(root);
  assert.ok(existsSync(join(root, 'user-data/health.md')));
  rmSync(root, { recursive: true, force: true });
});

test('shim: runStartupCheck returns findings with correct shape', async () => {
  const root = repo(true);
  const result = await runStartupCheck(root);
  assert.ok(Array.isArray(result.findings));
  for (const f of result.findings) {
    assert.ok(typeof f.level === 'string', 'finding has level');
    assert.ok(typeof f.message === 'string', 'finding has message');
    assert.ok(['FATAL', 'WARN', 'INFO'].includes(f.level), `level is valid: ${f.level}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('shim: deprecation notice fires to stderr', async () => {
  const root = repo(true);
  // Capture stderr
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return origWrite(chunk, ...args);
  };
  try {
    // The shim module is already loaded (module-level _deprecationLogged may be
    // set from a prior call in this process). Reset the flag via a fresh import
    // workaround: we test that the deprecation string appears somewhere in the
    // warning text when called. Because ES module singletons share state within
    // a process, we instead verify the stderr content from a sub-process.
    //
    // Sub-process approach: spawn node and check stderr output.
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { runStartupCheck } from ${JSON.stringify(
        new URL('../scripts/startup-check.js', import.meta.url).pathname
      )}; await runStartupCheck(${JSON.stringify(root)});`
    ], { encoding: 'utf-8' });
    assert.ok(
      result.stderr.includes('DEPRECATED'),
      `expected DEPRECATED in stderr, got: ${result.stderr}`
    );
  } finally {
    process.stderr.write = origWrite;
    rmSync(root, { recursive: true, force: true });
  }
});
