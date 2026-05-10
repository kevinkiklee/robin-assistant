import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  loadManifests,
  validateManifest,
} from '../../src/integrations/_framework/manifest-loader.js';

test('validateManifest accepts valid scheduled manifest', () => {
  const m = {
    name: 'gmail',
    cadence: '15m',
    embed: true,
    capture_mode: 'insert-or-skip',
    auth: { kind: 'oauth2-google', scopes: [] },
    tools: [],
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
  };
  const r = validateManifest(m);
  assert.equal(r.cadence_ms, null);
});

test('validateManifest rejects missing name', () => {
  assert.throws(() => validateManifest({ cadence: '15m', auth: { kind: 'api-key' }, tools: [] }));
});

test('validateManifest rejects unknown auth.kind', () => {
  assert.throws(() =>
    validateManifest({
      name: 'x',
      cadence: '15m',
      auth: { kind: 'magic' },
      tools: [],
    }),
  );
});

test('validateManifest defaults capture_mode to insert-or-skip', () => {
  const m = { name: 'x', cadence: '1h', embed: true, auth: { kind: 'api-key' }, tools: [] };
  const r = validateManifest(m);
  assert.equal(r.capture_mode, 'insert-or-skip');
});

test('loadManifests returns array (smoke against real integrations dir)', async () => {
  const integrationsDir = resolve(import.meta.dirname, '../../src/integrations');
  const manifests = await loadManifests(integrationsDir);
  assert.ok(Array.isArray(manifests));
});
