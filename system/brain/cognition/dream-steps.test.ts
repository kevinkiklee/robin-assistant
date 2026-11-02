import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { insertBeliefCandidate } from '../memory/belief-candidate.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { ALL_DREAM_STEPS, parseDreamSteps, runDream } from './dream.ts';

/** Fresh DB in a temp user-data dir; returns a teardown that closes it and restores the env var. */
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-dream-steps-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const prev = process.env.ROBIN_USER_DATA_DIR;
  process.env.ROBIN_USER_DATA_DIR = dir;
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  const teardown = () => {
    closeDb(db);
    if (prev === undefined) delete process.env.ROBIN_USER_DATA_DIR;
    else process.env.ROBIN_USER_DATA_DIR = prev;
  };
  return { db, teardown };
}

function seedOldCandidate(db: ReturnType<typeof freshDb>['db']) {
  insertBeliefCandidate(db, {
    topic: 'x.y',
    claim: 'Sim claim long enough to keep',
    confidence: 0.1,
    provenance: 'inferred',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = datetime('now','-30 days')`).run();
}

test('runDream steps: omitting "expire" leaves an old pending candidate pending', async () => {
  const { db, teardown } = freshDb();
  try {
    seedOldCandidate(db);
    const steps = new Set(ALL_DREAM_STEPS.filter((s) => s !== 'expire' && s !== 'lifecycle'));
    const r = await runDream(db, null, new Date(), { domainGating: false, steps });
    assert.equal(r.candidatesExpired, 0);
    const row = db.prepare('SELECT status FROM belief_candidates').get() as { status: string };
    assert.equal(row.status, 'pending');
  } finally {
    teardown();
  }
});

test('runDream steps: only "expire" expires the same candidate', async () => {
  const { db, teardown } = freshDb();
  try {
    seedOldCandidate(db);
    const r = await runDream(db, null, new Date(), {
      domainGating: false,
      steps: new Set(['expire']),
    });
    assert.equal(r.candidatesExpired, 1);
    assert.equal(r.journalGenerated, false);
  } finally {
    teardown();
  }
});

test('ALL_DREAM_STEPS lists 17 unique steps', () => {
  assert.equal(new Set(ALL_DREAM_STEPS).size, 17);
});

test('dream steps: topics runs right after lifecycle and owns topic hygiene', () => {
  const i = ALL_DREAM_STEPS.indexOf('lifecycle');
  assert.equal(ALL_DREAM_STEPS[i + 1], 'topics');
  const src = readFileSync(new URL('./dream.ts', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("if (on('topics'))"));
  assert.ok(block.length < src.length, "no if (on('topics')) block");
  assert.ok(block.slice(0, 400).includes('runTopicHygiene'), 'topic hygiene is not under topics');
});

test('parseDreamSteps: known names become a set, unknown names throw', () => {
  assert.deepEqual([...parseDreamSteps(['expire', 'lifecycle'])], ['expire', 'lifecycle']);
  assert.throws(() => parseDreamSteps(['lifecycle', 'lifecyle']), /unknown dream step: lifecyle/);
});
