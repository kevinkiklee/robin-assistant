import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  _resetManifestLoaderWarnings,
  loadManifests,
  validateManifest,
} from '../../io/integrations/_framework/manifest-loader.js';

test('validateManifest accepts valid scheduled manifest', () => {
  const m = {
    name: 'gmail',
    cadence: '15m',
    embed: true,
    capture_mode: 'insert-or-skip',
    auth: { kind: 'oauth2-google', scopes: [] },
    tools: [],
    sync: async () => ({}),
  };
  const r = validateManifest(m);
  assert.equal(r.name, 'gmail');
  assert.equal(r.cadence_ms, 900_000);
});

test('validateManifest accepts gateway manifest with cadence: null', () => {
  const m = {
    name: 'discord',
    cadence: null,
    embed: false,
    auth: { kind: 'discord-bot' },
    tools: [],
    start: async () => ({}),
  };
  const r = validateManifest(m);
  assert.equal(r.cadence_ms, null);
});

test('validateManifest rejects missing name', () => {
  assert.throws(() =>
    validateManifest({
      cadence: '15m',
      auth: { kind: 'api-key' },
      tools: [],
      sync: async () => ({}),
    }),
  );
});

test('validateManifest rejects unknown auth.kind', () => {
  assert.throws(() =>
    validateManifest({
      name: 'x',
      cadence: '15m',
      auth: { kind: 'magic' },
      tools: [],
      sync: async () => ({}),
    }),
  );
});

test('validateManifest defaults capture_mode to insert-or-skip', () => {
  const m = {
    name: 'x',
    cadence: '1h',
    embed: true,
    auth: { kind: 'api-key' },
    tools: [],
    sync: async () => ({}),
  };
  const r = validateManifest(m);
  assert.equal(r.capture_mode, 'insert-or-skip');
});

test('loadManifests returns { loaded, unavailable } (smoke against real integrations dir)', async () => {
  const integrationsDir = resolve(import.meta.dirname, '../../io/integrations');
  const r = await loadManifests(integrationsDir);
  assert.ok(Array.isArray(r.loaded));
  assert.ok(Array.isArray(r.unavailable));
});

test('loadManifests warns only once per (integration, error) across repeated calls', async (t) => {
  // Heartbeat-driven invariants re-scan manifest dirs every tick. Without
  // dedupe, the same "integration X: skipped — env required" warning fires
  // every tick — 478 lines in 4 days of real daemon.log. This guards the fix.
  _resetManifestLoaderWarnings();
  const root = mkdtempSync(join(tmpdir(), 'robin-manifest-warn-'));
  const intDir = join(root, 'broken_int');
  mkdirSync(intDir, { recursive: true });
  writeFileSync(
    join(intDir, 'manifest.js'),
    [
      'export const manifest = {',
      "  name: 'broken_int',",
      "  cadence: '1h',",
      "  auth: { kind: 'api-key' },",
      '  tools: [],',
      '  sync: async () => ({}),',
      "  preflight: () => { throw new Error('missing env BROKEN_KEY'); },",
      '};',
      '',
    ].join('\n'),
  );

  const calls = [];
  const origWarn = console.warn;
  console.warn = (m) => calls.push(m);
  t.after(() => {
    console.warn = origWarn;
    _resetManifestLoaderWarnings();
  });

  await loadManifests(root);
  await loadManifests(root);
  await loadManifests(root);

  const skipped = calls.filter((m) => m.includes('broken_int: skipped'));
  assert.equal(skipped.length, 1, `expected one skipped warning, got: ${skipped.length}`);
});

test('loadManifests silently skips directories with no manifest.js (shared-code dirs)', async (t) => {
  // system/io/integrations/discord and /imessage hold shared helper code
  // (formatter, sender, SQLite reader) imported by user-data integrations.
  // They live in the integrations/ namespace but are not themselves
  // integrations. They must not trigger "Cannot find module" warnings on
  // every daemon-lifetime — the warning surfaces as false breakage in
  // `robin doctor`.
  _resetManifestLoaderWarnings();
  const root = mkdtempSync(join(tmpdir(), 'robin-manifest-shared-'));
  // Real integration with manifest:
  const realDir = join(root, 'real_int');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(
    join(realDir, 'manifest.js'),
    [
      'export const manifest = {',
      "  name: 'real_int',",
      "  cadence: '1h',",
      "  auth: { kind: 'api-key' },",
      '  tools: [],',
      '  sync: async () => ({}),',
      '};',
      '',
    ].join('\n'),
  );
  // Shared-code dir, no manifest.js — should be skipped silently.
  const sharedDir = join(root, 'shared_helpers');
  mkdirSync(sharedDir, { recursive: true });
  writeFileSync(join(sharedDir, 'formatter.js'), 'export function f(){}\n');

  const calls = [];
  const origWarn = console.warn;
  console.warn = (m) => calls.push(m);
  t.after(() => {
    console.warn = origWarn;
    _resetManifestLoaderWarnings();
  });

  const r = await loadManifests(root);
  assert.equal(r.loaded.length, 1, 'only real_int should load');
  assert.equal(r.loaded[0].name, 'real_int');
  const sharedWarn = calls.filter((m) => m.includes('shared_helpers'));
  assert.equal(
    sharedWarn.length,
    0,
    `shared_helpers should not warn; got: ${sharedWarn.join(' | ')}`,
  );
});
