import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadManifests } from '../../src/integrations/_framework/manifest-loader.js';

let tmpDir;

test.beforeEach(() => {
  tmpDir = join(tmpdir(), `robin-integ-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

test.afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('preflight failure surfaces in unavailable list with the underlying error message', async () => {
  // Available integration — preflight passes.
  mkdirSync(join(tmpDir, 'good'), { recursive: true });
  writeFileSync(
    join(tmpDir, 'good', 'manifest.js'),
    `
      export const manifest = {
        name: 'good',
        cadence: '1h',
        auth: { kind: 'api-key' },
        tools: [],
        sync: async () => ({}),
        preflight: async () => {},
      };
    `,
    'utf-8',
  );

  // Unavailable integration — manifest valid, preflight fails because the
  // local data source path doesn't exist.
  mkdirSync(join(tmpDir, 'fake'), { recursive: true });
  writeFileSync(
    join(tmpDir, 'fake', 'manifest.js'),
    `
      export const manifest = {
        name: 'fake',
        cadence: '1h',
        auth: { kind: 'api-key' },
        tools: [],
        sync: async () => ({}),
        preflight: async () => { throw new Error('source not found: /imaginary/path'); },
      };
    `,
    'utf-8',
  );

  const { loaded, unavailable } = await loadManifests(tmpDir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'good');
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].name, 'fake');
  assert.match(unavailable[0].error, /source not found/);
  assert.match(unavailable[0].error, /\/imaginary\/path/);
});

test('multiple unavailable integrations all surface with their distinct errors', async () => {
  for (const [name, message] of [
    ['no-secret', 'missing secrets: FOO_TOKEN (run: robin auth foo)'],
    ['no-source', 'source not found: /Users/test/nonexistent.sqlite'],
    ['no-net', 'preflight ping failed: getaddrinfo EAI_AGAIN api.example.com'],
  ]) {
    mkdirSync(join(tmpDir, name), { recursive: true });
    writeFileSync(
      join(tmpDir, name, 'manifest.js'),
      `
        export const manifest = {
          name: '${name}',
          cadence: '1h',
          auth: { kind: 'api-key' },
          tools: [],
          sync: async () => ({}),
          preflight: async () => { throw new Error(${JSON.stringify(message)}); },
        };
      `,
      'utf-8',
    );
  }

  const { loaded, unavailable } = await loadManifests(tmpDir);
  assert.equal(loaded.length, 0);
  assert.equal(unavailable.length, 3);
  const byName = Object.fromEntries(unavailable.map((u) => [u.name, u.error]));
  assert.match(byName['no-secret'], /missing secrets: FOO_TOKEN/);
  assert.match(byName['no-source'], /source not found/);
  assert.match(byName['no-net'], /EAI_AGAIN/);
});
