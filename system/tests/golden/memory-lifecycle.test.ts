import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { runDream } from '../../brain/cognition/dream.ts';
import { applyCorrections } from '../../brain/learning/apply-corrections.ts';
import { believe } from '../../brain/memory/belief.ts';
import { insertBeliefCandidate } from '../../brain/memory/belief-candidate.ts';
import { openDb } from '../../brain/memory/db.ts';
import { addRelation, upsertEntity } from '../../brain/memory/entity.ts';
import { ingest } from '../../brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { pinSqlClock } from '../../lib/sql-clock.ts';
import { dumpDb } from './dump-db.ts';

// Characterization test for the test-lab seams (docs/design/2026-10-19-robin-test-lab-design.md §8.2).
// Every seam refactor must keep this dump byte-identical. Regenerate ONLY when a
// behaviour change is intended: UPDATE_GOLDEN=1 pnpm exec tsx --test <this file>.
const T0 = Date.parse('2027-01-04T15:00:00Z');
const GOLDEN = join(import.meta.dirname, 'memory-lifecycle.golden');

async function runScenario(): Promise<Record<string, unknown[]>> {
  const dir = mkdtempSync(join(tmpdir(), 'robin-golden-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const prevUserData = process.env.ROBIN_USER_DATA_DIR;
  process.env.ROBIN_USER_DATA_DIR = dir;
  mock.timers.enable({ apis: ['Date'], now: T0 });
  try {
    const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
    pinSqlClock(db, () => Date.now());
    applyMigrations(db, allMigrations);

    const ev = ingest(db, null, {
      kind: 'session.captured',
      source: 'capture',
      content: 'Sim User plans a spring trip to Juniper Lake and drops the Pine Ridge leg.',
    });
    insertBeliefCandidate(db, {
      topic: 'spring-trip.route',
      claim: 'Spring trip goes to Juniper Lake, not Pine Ridge',
      confidence: 0.9,
      sourceEventId: ev.eventId,
      provenance: 'first-party',
    });
    insertBeliefCandidate(db, {
      topic: 'gear.wishlist',
      claim: 'Considering a new tent',
      confidence: 0.6,
      sourceEventId: ev.eventId,
      provenance: 'inferred',
    });
    believe(db, null, {
      topic: 'gear.bike',
      claim: 'Owns a road bike',
      provenance: 'first-party',
      sources: [ev.eventId],
    });
    const place = upsertEntity(db, 'place', 'Juniper Lake');
    const person = upsertEntity(db, 'person', 'Sim User');
    addRelation(db, person.id, 'plans_trip_to', place.id, ev.eventId);
    db.prepare(
      `INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`,
    ).run('route', 'No Pine Ridge leg', 'golden', 'spring-trip.route');

    mock.timers.tick(8 * 86_400_000);
    await runDream(db, null, new Date(), { domainGating: false });
    await applyCorrections(db, null, new Date());
    mock.timers.tick(20 * 86_400_000);
    await runDream(db, null, new Date(), { domainGating: false });

    const dump = dumpDb(db);
    db.close();
    return dump;
  } finally {
    mock.timers.reset();
    if (prevUserData === undefined) delete process.env.ROBIN_USER_DATA_DIR;
    else process.env.ROBIN_USER_DATA_DIR = prevUserData;
  }
}

test('golden: memory lifecycle dump is deterministic and unchanged', async () => {
  const a = await runScenario();
  const b = await runScenario();
  assert.deepEqual(a, b, 'scenario must be deterministic across runs');
  const json = `${JSON.stringify(a, null, 1)}\n`;
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, json);
  assert.ok(existsSync(GOLDEN), 'golden file missing — run once with UPDATE_GOLDEN=1');
  assert.equal(json, readFileSync(GOLDEN, 'utf8'));
});
