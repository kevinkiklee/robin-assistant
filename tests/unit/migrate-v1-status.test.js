import assert from 'node:assert';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { printStatus } from '../../src/migrate-v1/status.js';
import { paths } from '../../src/runtime/data-store.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

test('printStatus reports progress + counts', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths().migrationsDir);
    await db
      .query(
        surql`UPSERT type::record('runtime', 'migration_progress') SET value = ${{
          v1_to_v2: {
            started_at: '2026-05-12T00:00:00Z',
            completed_phases: ['entity'],
            current_phase: 'episode',
            cursor: { episode: { last_v1_id: 'episode:foo' } },
            counts: {
              entity: { imported: 949, dup: 0, skipped: 0 },
              episode: { imported: 12, dup: 0, skipped: 0 },
            },
          },
        }}`,
      )
      .collect();

    const lines = [];
    await printStatus(db, (s) => lines.push(s));
    const out = lines.join('\n');
    assert.match(out, /entity.*949/);
    assert.match(out, /episode/);
    assert.match(out, /failures recorded: 0/);
  } finally {
    await close(db);
  }
});

test('printStatus on no-progress reports gracefully', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths().migrationsDir);
    const lines = [];
    await printStatus(db, (s) => lines.push(s));
    assert.match(lines.join('\n'), /no migration in progress/);
  } finally {
    await close(db);
  }
});
