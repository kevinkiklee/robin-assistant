import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeRole } from '../../lib/cloud/role.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { tickWithRetryAndHeartbeat } from './scheduler-glue.ts';
import type { IntegrationContext } from './types.ts';

function setup(role?: 'vm-dry-run' | 'mac-locked' | 'vm-primary') {
  const d = mkdtempSync(join(tmpdir(), 'robin-tick-guard-'));
  process.env.ROBIN_USER_DATA_DIR = d;
  if (role) writeRole(d, { role, at: '2026-11-02T00:00:00.000Z' });
  let ticks = 0;
  const heartbeats: unknown[] = [];
  const db = {
    prepare: () => ({
      run: (...a: unknown[]) => heartbeats.push(a),
      get: () => undefined,
      all: () => [],
    }),
  };
  const module = {
    tick: () => {
      ticks++;
      return { status: 'ok' as const, ingested: 0 };
    },
  };
  return {
    run: () =>
      tickWithRetryAndHeartbeat(
        'whoop',
        module,
        { db } as unknown as IntegrationContext,
        createLogger({ module: 'test' }),
      ),
    ticks: () => ticks,
  };
}

for (const role of ['vm-dry-run', 'mac-locked'] as const) {
  test(`tick entry point refuses under ${role} without ticking`, async () => {
    const s = setup(role);
    await assert.rejects(s.run(), new RegExp(`cloud role ${role}: integrations are held`));
    assert.equal(s.ticks(), 0);
  });
}

test('tick entry point is unchanged with no role', async () => {
  const s = setup();
  await s.run();
  assert.equal(s.ticks(), 1);
});
