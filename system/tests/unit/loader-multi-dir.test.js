import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { loadManifests } from '../../io/integrations/_framework/manifest-loader.js';

function writeManifest(dir, name, body) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'manifest.js'), body);
}

test('loadManifests accepts an array of dirs and tags _source', async () => {
  const systemDir = mkdtempSync(join(tmpdir(), 'robin-sys-'));
  const userDir = mkdtempSync(join(tmpdir(), 'robin-user-'));
  try {
    writeManifest(
      systemDir,
      'foo',
      `export const manifest = { name: 'foo', cadence: '1h', sync: async () => {}, tools: [] };`,
    );
    writeManifest(
      userDir,
      'bar',
      `export const manifest = { name: 'bar', cadence: '1h', sync: async () => {}, tools: [] };`,
    );
    const { loaded } = await loadManifests([systemDir, userDir]);
    const byName = Object.fromEntries(loaded.map((m) => [m.name, m]));
    assert.equal(byName.foo._source, 'system');
    assert.equal(byName.bar._source, 'user-data');
    assert.equal(byName.foo._dir, join(systemDir, 'foo'));
    assert.equal(byName.bar._dir, join(userDir, 'bar'));
  } finally {
    rmSync(systemDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('on name collision, user-data wins and a warning is logged', async () => {
  const systemDir = mkdtempSync(join(tmpdir(), 'robin-sys-'));
  const userDir = mkdtempSync(join(tmpdir(), 'robin-user-'));
  const warn = mock.method(console, 'warn');
  try {
    writeManifest(
      systemDir,
      'dup',
      `export const manifest = { name: 'dup', cadence: '1h', sync: async () => 'sys', tools: [] };`,
    );
    writeManifest(
      userDir,
      'dup',
      `export const manifest = { name: 'dup', cadence: '1h', sync: async () => 'user', tools: [] };`,
    );
    const { loaded } = await loadManifests([systemDir, userDir]);
    const dup = loaded.find((m) => m.name === 'dup');
    assert.equal(dup._source, 'user-data');
    assert.ok(warn.mock.calls.some((c) => /collision/i.test(c.arguments[0])));
  } finally {
    warn.mock.restore();
    rmSync(systemDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('loadManifests with single-dir array preserves legacy behavior', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-legacy-'));
  try {
    writeManifest(
      dir,
      'foo',
      `export const manifest = { name: 'foo', cadence: '1h', sync: async () => {}, tools: [] };`,
    );
    const { loaded } = await loadManifests([dir]);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]._source, 'system');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadManifests accepts a string for backwards compat (legacy callers)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-string-'));
  try {
    writeManifest(
      dir,
      'foo',
      `export const manifest = { name: 'foo', cadence: '1h', sync: async () => {}, tools: [] };`,
    );
    const { loaded } = await loadManifests(dir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]._source, 'system');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
