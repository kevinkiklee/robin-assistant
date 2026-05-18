import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { surql } from 'surrealdb';
import { __setEnvForTests, checkDurableWrite } from '../../cognition/discretion/durable-write.js';
import { __resetCacheForTests } from '../../cognition/discretion/verbatim-scan.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../data/db/migrations');

let db;

before(async () => {
  db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_DIR);
});

after(async () => {
  await close(db);
});

beforeEach(() => {
  __resetCacheForTests();
  __setEnvForTests(null);
});

describe('checkDurableWrite', () => {
  it('enforce mode: remember refused on session taint without force', async () => {
    __setEnvForTests('enforce');
    const result = await checkDurableWrite(db, {
      destination: 'remember',
      text: 'Store my preferences for later',
      sessionTaint: { tainted: true },
      force: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'session_tainted');
  });

  it('record_correction NOT gated by taint (user utterance)', async () => {
    __setEnvForTests('enforce');
    const result = await checkDurableWrite(db, {
      destination: 'record_correction',
      text: 'Store my preferences for later',
      sessionTaint: { tainted: true },
      force: false,
    });
    assert.equal(result.ok, true);
  });

  it('log mode passes through but logs refusal', async () => {
    __setEnvForTests('log');
    const [before_rows] = await db.query(surql`SELECT * FROM refusals`).collect();
    const before_count = before_rows.length;
    const result = await checkDurableWrite(db, {
      destination: 'remember',
      text: 'Store my preferences for later',
      sessionTaint: { tainted: true },
      force: false,
    });
    assert.equal(result.ok, true, 'log mode should pass through');
    const [after_rows] = await db.query(surql`SELECT * FROM refusals`).collect();
    assert.equal(after_rows.length, before_count + 1, 'should have logged a refusal');
  });

  it('off mode skips all checks', async () => {
    __setEnvForTests('off');
    const result = await checkDurableWrite(db, {
      destination: 'remember',
      text: 'My SSN is 123-45-6789',
      sessionTaint: { tainted: true },
      force: false,
    });
    assert.equal(result.ok, true);
  });

  it('PII pattern refused regardless of taint exemption (enforce mode)', async () => {
    __setEnvForTests('enforce');
    // record_correction has pii:true but taint:false — PII should still block
    const result = await checkDurableWrite(db, {
      destination: 'record_correction',
      text: 'My SSN is 123-45-6789',
      sessionTaint: { tainted: false },
      force: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pii:ssn');
  });
});
