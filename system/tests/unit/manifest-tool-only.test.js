import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateManifest } from '../../io/integrations/_framework/manifest-loader.js';

test('tool-only manifest validates with kind=tool-only', () => {
  const m = validateManifest({
    name: 'github_write',
    cadence: null,
    auth: { kind: 'api-key' },
    tools: [() => ({ name: 'x', description: 'y', inputSchema: {}, handler: async () => ({}) })],
  });
  assert.equal(m.kind, 'tool-only');
});

test('sync manifest validates with kind=sync', () => {
  const m = validateManifest({
    name: 'gmail',
    cadence: '15m',
    auth: { kind: 'oauth2-google' },
    sync: async () => ({}),
  });
  assert.equal(m.kind, 'sync');
});

test('gateway manifest validates with kind=gateway', () => {
  const m = validateManifest({
    name: 'discord',
    cadence: null,
    auth: { kind: 'discord-bot' },
    start: async () => ({}),
  });
  assert.equal(m.kind, 'gateway');
});

test('rejects manifest with no sync, no start, no tools', () => {
  assert.throws(() =>
    validateManifest({
      name: 'broken',
      cadence: null,
      auth: { kind: 'api-key' },
    }),
  );
});
