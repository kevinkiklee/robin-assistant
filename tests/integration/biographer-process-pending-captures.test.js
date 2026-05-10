import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { biographerProcessPending } from '../../src/cli/commands/biographer-process-pending.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

function transcriptPair(userText, assistantText) {
  const dir = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    `${[
      { type: 'user', message: { role: 'user', content: userText } },
      { type: 'assistant', message: { role: 'assistant', content: assistantText } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n')}\n`,
    'utf8',
  );
  return path;
}

test('biographer-process-pending --transcript-path runs capture pre-step', async () => {
  // Sanity: with --transcript-path, the conversation event lands in `events`.
  const path = transcriptPair('drop the watches feature', 'OK, removed it.');

  // The CLI command connects to the rocksdb path under ROBIN_HOME; pre-migrate
  // it ourselves so the same DB the CLI opens has the schema applied.
  const homeDb = `rocksdb://${__robinTestHome}/db`;
  const seedDb = await connect({ engine: homeDb });
  try {
    await runMigrations(seedDb, resolve(import.meta.dirname, '../../src/schema/migrations'));
  } finally {
    await close(seedDb);
  }

  await biographerProcessPending(['--transcript-path', path, '--session-id', 's1']);

  const verifyDb = await connect({ engine: homeDb });
  try {
    const [rows] = await verifyDb
      .query(surql`SELECT source, meta FROM events WHERE source = 'conversation'`)
      .collect();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.session_id, 's1');
  } finally {
    await close(verifyDb);
  }
});
