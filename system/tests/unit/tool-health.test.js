import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHealthTool } from '../../io/mcp/tools/health.js';

test('health returns ok when all subsystems are up', async () => {
  const tool = createHealthTool({
    version: '6.0.0-alpha.2',
    startedAt: new Date(Date.now() - 5000),
    db: { isOpen: () => true, query: () => ({ collect: async () => [[]] }) },
    embedder: { isLoaded: () => false },
    biographerQueue: { lastRunAt: null },
    sessions: { count: 0 },
  });
  const result = await tool.handler({});
  assert.equal(result.status, 'ok');
  assert.equal(result.version, '6.0.0-alpha.2');
  assert.ok(result.uptime_seconds >= 4);
  assert.equal(result.db_open, true);
  assert.equal(result.embedder_loaded, false);
});

test('health.name is "health"', () => {
  const tool = createHealthTool({
    version: 'x',
    startedAt: new Date(),
    db: { isOpen: () => true, query: () => ({ collect: async () => [[]] }) },
    embedder: { isLoaded: () => false },
    biographerQueue: { lastRunAt: null },
    sessions: { count: 0 },
  });
  assert.equal(tool.name, 'health');
});

test('health degrades when db is closed', async () => {
  const tool = createHealthTool({
    version: 'x',
    startedAt: new Date(),
    db: {
      isOpen: () => false,
      query: () => ({
        collect: async () => {
          throw new Error('db down');
        },
      }),
    },
    embedder: { isLoaded: () => false },
    biographerQueue: { lastRunAt: null },
    sessions: { count: 0 },
  });
  const result = await tool.handler({});
  assert.equal(result.status, 'degraded');
});
