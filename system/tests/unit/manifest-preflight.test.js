import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadManifests } from '../../io/integrations/_framework/manifest-loader.js';

let tmpDir;

test.beforeEach(() => {
  tmpDir = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

test.afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('loadManifests returns { loaded, unavailable } and partitions by preflight outcome', async () => {
  mkdirSync(join(tmpDir, 'good'), { recursive: true });
  writeFileSync(
    join(tmpDir, 'good', 'manifest.js'),
    `
      export const manifest = {
        name: 'good',
        cadence: '1h',
        auth: { kind: 'api-key' },
        tools: [],
        preflight: async () => {},
        sync: async () => ({}),
      };
    `,
    'utf-8',
  );
  mkdirSync(join(tmpDir, 'bad'), { recursive: true });
  writeFileSync(
    join(tmpDir, 'bad', 'manifest.js'),
    `
      export const manifest = {
        name: 'bad',
        cadence: '1h',
        auth: { kind: 'api-key' },
        tools: [],
        preflight: async () => { throw new Error('source not found: /nope'); },
        sync: async () => ({}),
      };
    `,
    'utf-8',
  );

  const { loaded, unavailable } = await loadManifests(tmpDir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'good');
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].name, 'bad');
  assert.match(unavailable[0].error, /source not found/);
});

test('loadManifests treats manifests without preflight as automatically loaded', async () => {
  mkdirSync(join(tmpDir, 'plain'), { recursive: true });
  writeFileSync(
    join(tmpDir, 'plain', 'manifest.js'),
    `
      export const manifest = {
        name: 'plain',
        cadence: '1h',
        auth: { kind: 'api-key' },
        tools: [],
        sync: async () => ({}),
      };
    `,
    'utf-8',
  );

  const { loaded, unavailable } = await loadManifests(tmpDir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'plain');
  assert.equal(loaded[0].preflight, null);
  assert.equal(unavailable.length, 0);
});

test('loadManifests returns empty result when integrations dir is missing', async () => {
  const r = await loadManifests(join(tmpDir, 'does-not-exist'));
  assert.deepEqual(r, { loaded: [], unavailable: [] });
});
