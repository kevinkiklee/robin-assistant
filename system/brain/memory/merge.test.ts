import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from './db.ts';
import { addRelation, upsertEntity } from './entity.ts';
import { applyMigrations, allMigrations } from './migrations/index.ts';
import { mergeEntities, resolveEntityRef } from './merge.ts';

function freshDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'merge-test-')), 'test.db'));
  applyMigrations(db, allMigrations);
  return db;
}

const count = (db: ReturnType<typeof freshDb>) =>
  (db.prepare('SELECT COUNT(*) c FROM entities').get() as { c: number }).c;

test('mergeEntities: dry run computes scale and mutates nothing', () => {
  const db = freshDb();
  const keep = upsertEntity(db, 'person', 'Kevin Lee');
  const drop = upsertEntity(db, 'person', 'Kevin K. Lee');
  const s = upsertEntity(db, 'service', 'Spotify');
  addRelation(db, keep.id, 'uses', s.id);
  addRelation(db, drop.id, 'uses', s.id); // dup after merge
  addRelation(db, keep.id, 'knows', drop.id); // self-loop after merge
  addRelation(db, drop.id, 'owns', s.id); // distinct predicate, preserved

  const before = count(db);
  const plan = mergeEntities(db, [{ keep: keep.id, drops: [drop.id] }]); // no apply
  assert.equal(plan.applied, false);
  assert.equal(plan.totals.entitiesRemoved, 1);
  assert.equal(plan.totals.relationsRepointed, 3);
  assert.equal(plan.totals.relationsDeduped, 1);
  assert.equal(plan.totals.selfLoopsRemoved, 1);
  // nothing changed
  assert.equal(count(db), before);
  assert.ok(db.prepare('SELECT 1 FROM entities WHERE id=?').get(drop.id), 'drop still present');
  closeDb(db);
});

test('mergeEntities: apply re-points, dedups, removes self-loops, coalesces profile', () => {
  const db = freshDb();
  const keep = upsertEntity(db, 'person', 'Kevin Lee'); // no profile
  const drop = upsertEntity(db, 'person', 'Kevin K. Lee', 'The primary user.');
  const s = upsertEntity(db, 'service', 'Spotify');
  const other = upsertEntity(db, 'thing', 'Letterboxd');
  addRelation(db, keep.id, 'uses', s.id);
  addRelation(db, drop.id, 'uses', s.id); // collapses into the above
  addRelation(db, keep.id, 'knows', drop.id); // becomes self-loop, removed
  addRelation(db, drop.id, 'owns', other.id); // re-pointed, preserved

  const plan = mergeEntities(db, [{ keep: keep.id, drops: [drop.id] }], { apply: true });
  assert.equal(plan.applied, true);

  assert.equal(
    db.prepare('SELECT 1 FROM entities WHERE id=?').get(drop.id),
    undefined,
    'drop deleted',
  );
  const keepProfile = (
    db.prepare('SELECT profile FROM entities WHERE id=?').get(keep.id) as {
      profile: string | null;
    }
  ).profile;
  assert.equal(keepProfile, 'The primary user.', 'profile coalesced from drop');

  const rels = db
    .prepare('SELECT predicate, object_id FROM relations WHERE subject_id=? OR object_id=?')
    .all(keep.id, keep.id) as Array<{ predicate: string; object_id: number }>;
  const triples = rels.map((r) => `${r.predicate}->${r.object_id}`).sort();
  assert.deepEqual(
    triples,
    [`owns->${other.id}`, `uses->${s.id}`],
    'one uses (deduped), owns kept, no self-loop',
  );
  closeDb(db);
});

test('mergeEntities: resolves <type>:<name> refs', () => {
  const db = freshDb();
  const keep = upsertEntity(db, 'project', 'photo-tools');
  upsertEntity(db, 'project', 'phototools');
  const resolved = resolveEntityRef(db, 'project:photo-tools');
  assert.equal(resolved.id, keep.id);
  const plan = mergeEntities(db, [{ keep: 'project:photo-tools', drops: ['project:phototools'] }], {
    apply: true,
  });
  assert.equal(plan.totals.entitiesRemoved, 1);
  assert.equal(count(db), 1);
  closeDb(db);
});

test('mergeEntities: rejects chained merges, self-drop, and duplicate drops', () => {
  const db = freshDb();
  const a = upsertEntity(db, 'thing', 'A');
  const b = upsertEntity(db, 'thing', 'B');
  const c = upsertEntity(db, 'thing', 'C');
  // chained: B is both a keep and a drop
  assert.throws(
    () =>
      mergeEntities(db, [
        { keep: a.id, drops: [b.id] },
        { keep: b.id, drops: [c.id] },
      ]),
    /chained merges/,
  );
  // keep listed as its own drop
  assert.throws(() => mergeEntities(db, [{ keep: a.id, drops: [a.id] }]), /its own drop/);
  // same drop in two groups
  assert.throws(
    () =>
      mergeEntities(db, [
        { keep: a.id, drops: [c.id] },
        { keep: b.id, drops: [c.id] },
      ]),
    /more than one group/,
  );
  // unknown ref
  assert.throws(() => mergeEntities(db, [{ keep: a.id, drops: [999999] }]), /no entity with id/);
  closeDb(db);
});
