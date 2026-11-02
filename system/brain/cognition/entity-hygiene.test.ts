import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { addRelation, upsertEntity } from '../memory/entity.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import {
  entityTokens,
  gearTokens,
  loadEntities,
  nominateGroups,
  runEntityHygiene,
  typeClass,
} from './entity-hygiene.ts';

function freshDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'robin-entity-hygiene-')), 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** An invented bike wheelset under many names (one with a wrong rim depth),
 *  plus look-alikes that must stay separate. */
const WHEEL_NAMES: Array<[string, string]> = [
  ['product', 'Velora Aero 38mm Wheelset'],
  ['product', 'Velora Aero 38 Wheelset'],
  ['product', 'Aero 38mm wheelset'],
  ['gear', 'Aero 38'],
  ['product', 'Velora Aero 54mm Wheelset'],
];
const DISTINCT_NAMES: Array<[string, string]> = [
  ['product', 'Velora 20-30mm Wheelset'],
  ['gear', 'Brio K7 III'],
  ['gear', 'Brio K7III'],
  ['gear', 'Brio K7'],
];

function seed(db: ReturnType<typeof freshDb>) {
  const sam = upsertEntity(db, 'person', 'Sam Rivera');
  const commuting = upsertEntity(db, 'topic', 'commuting');
  const ids = new Map<string, number>();
  for (const [type, name] of [...WHEEL_NAMES, ...DISTINCT_NAMES]) {
    const e = upsertEntity(db, type, name);
    ids.set(name, e.id);
    addRelation(db, sam.id, 'owns', e.id);
  }
  // The most-used name gets extra relations so it is the natural survivor.
  addRelation(db, ids.get('Velora Aero 38mm Wheelset') as number, 'used_for', commuting.id);
  addRelation(db, ids.get('Aero 38') as number, 'used_for', commuting.id); // dup after merge
  return { ids, sam, commuting };
}

/** Judge stub: reads each GROUP's member lines from the prompt and clusters the
 *  names `clusterOf` maps to the same key. */
function fakeJudge(
  clusterOf: (name: string) => string | null,
  canonical: (key: string) => string,
  calls: { n: number },
): LLMDispatcher {
  return {
    invoke: async (_role: string, req: { messages: Array<{ content: string }> }) => {
      calls.n++;
      const groups = req.messages[0].content.split(/\n\n/).map((block, g) => {
        const byKey = new Map<string, number[]>();
        for (const m of block.matchAll(/\[(\d+)\] \w+ "([^"]+)"/g)) {
          const key = clusterOf(m[2]);
          if (!key) continue;
          const list = byKey.get(key) ?? [];
          list.push(Number(m[1]));
          byKey.set(key, list);
        }
        const clusters = [...byKey.entries()]
          .filter(([, l]) => l.length >= 2)
          .map(([key, members]) => ({ members, keep: members[0], canonical_name: canonical(key) }));
        return { group: g, clusters };
      });
      return {
        text: '',
        structured: { groups },
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'fake',
      };
    },
  } as unknown as LLMDispatcher;
}

const isAero = (name: string) => (WHEEL_NAMES.some(([, n]) => n === name) ? 'aero' : null);

test('gearTokens: folds brand words, f-numbers, mm, PF/S/VR and model suffixes', () => {
  // Invented specs — the parser rules, not any real product.
  assert.deepEqual(gearTokens('Acme 37mm f/2.1 DG VR (PF)'), ['acme', '37', 'f2.1', 'dg']);
  assert.deepEqual(gearTokens('Nikkor Z 37mm f2.1'), ['37', 'f2.1']);
  assert.deepEqual(gearTokens('Brio K7 III'), ['brio', 'k7iii']);
  assert.deepEqual(gearTokens('K 7III'), ['k7iii']);
  assert.deepEqual(gearTokens('Brio K 5'), ['brio', 'k5']);
  assert.deepEqual(gearTokens('Acme 21-47mm f/3.3-5.9 OS'), ['acme', '21-47', 'f3.3-5.9', 'os']);
  assert.deepEqual(gearTokens('Acme Z 29mm f/2.4 S'), ['acme', '29', 'f2.4']);
  assert.deepEqual(gearTokens('Velora Aero 38mm Wheelset'), ['velora', 'aero', '38', 'wheelset']);
  assert.deepEqual(gearTokens('Acme QX T9 Mark II'), ['acme', 'qx', 't9ii']);
});

test('entityTokens/typeClass: gear rules only for the equipment class', () => {
  assert.equal(typeClass('lens'), typeClass('gear'));
  assert.equal(typeClass('company'), typeClass('organization'));
  assert.equal(typeClass('species'), 'species');
  assert.deepEqual(entityTokens('Velora Club', 'organization'), ['velora', 'club']);
});

test('nominateGroups: the Aero 38 family groups; 20-30 and K7 vs K7 III stay apart', () => {
  const db = freshDb();
  seed(db);
  const ents = loadEntities(db);
  const { groups } = nominateGroups(ents, new Set());
  const named = groups.map((g) => g.members.map((m) => ents[m].name).sort());
  const aero = named.find((g) => g.includes('Aero 38'));
  assert.ok(aero, 'a group contains Aero 38');
  for (const [, n] of WHEEL_NAMES) assert.ok(aero.includes(n), `${n} nominated with the family`);
  assert.ok(!aero.includes('Velora 20-30mm Wheelset'), '20-30 is a different wheelset');
  const k7 = named.find((g) => g.includes('Brio K7 III'));
  assert.deepEqual(k7, ['Brio K7 III', 'Brio K7III']);
  closeDb(db);
});

test('runEntityHygiene: dry run judges but writes nothing', async () => {
  const db = freshDb();
  seed(db);
  const before = loadEntities(db).length;
  const calls = { n: 0 };
  const r = await runEntityHygiene(
    db,
    fakeJudge(isAero, () => 'Velora Aero 38mm Wheelset', calls),
  );
  assert.equal(calls.n, 1);
  assert.ok(r.clustersProposed >= 1);
  assert.equal(r.merged, 0);
  assert.equal(loadEntities(db).length, before);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind='entity.hygiene'`).get() as {
    n: number;
  };
  assert.equal(n.n, 0);
  const aliases = db.prepare(`SELECT COUNT(*) AS n FROM entity_aliases`).get() as { n: number };
  assert.equal(aliases.n, 0);
  closeDb(db);
});

test('runEntityHygiene --apply: merges the family, records aliases + verdicts, converges', async () => {
  const db = freshDb();
  const { ids, commuting } = seed(db);
  const keepId = ids.get('Velora Aero 38mm Wheelset') as number;
  const calls = { n: 0 };
  const judge = fakeJudge(
    (name) => isAero(name) ?? (/K7 ?III/.test(name) ? 'k7iii' : null),
    (key) => (key === 'aero' ? 'Velora Aero 38mm Wheelset' : 'Brio K7 III'),
    calls,
  );
  const r = await runEntityHygiene(db, judge, { apply: true });
  assert.equal(r.merged, 2);
  assert.equal(r.entitiesRemoved, WHEEL_NAMES.length - 1 + 1);

  const names = loadEntities(db).map((e) => e.name);
  for (const [, n] of WHEEL_NAMES.slice(1)) assert.ok(!names.includes(n), `${n} merged away`);
  assert.ok(names.includes('Velora Aero 38mm Wheelset'));
  assert.ok(names.includes('Velora 20-30mm Wheelset'), '20-30 untouched');
  assert.ok(names.includes('Brio K7'), 'K7 (gen 1) untouched');

  // Relations re-pointed and deduped onto the survivor.
  const uses = db
    .prepare(`SELECT COUNT(*) AS n FROM relations WHERE subject_id=? AND object_id=?`)
    .get(keepId, commuting.id) as { n: number };
  assert.equal(uses.n, 1);

  // Retired names resolve to the survivor from now on.
  const alias = db
    .prepare(`SELECT canonical_name, canonical_type, source FROM entity_aliases WHERE alias = ?`)
    .get('aero 38') as { canonical_name: string; canonical_type: string; source: string };
  assert.deepEqual(alias, {
    canonical_name: 'Velora Aero 38mm Wheelset',
    canonical_type: 'product',
    source: 'entity-hygiene',
  });
  assert.equal(upsertEntity(db, 'gear', 'Aero 38mm wheelset').id, keepId);

  const merged = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events WHERE kind='entity.hygiene' AND json_extract(payload,'$.verdict')='merged'`,
    )
    .get() as { n: number };
  assert.equal(merged.n, 2);

  // Second run: what the judge split is never re-judged → no LLM call at all.
  const again = await runEntityHygiene(db, judge, { apply: true });
  assert.equal(again.groupsNominated, 0);
  assert.equal(calls.n, 1);
  closeDb(db);
});

test('runEntityHygiene: judge failure = no merge, nothing recorded', async () => {
  const db = freshDb();
  seed(db);
  const before = loadEntities(db).length;
  const broken = {
    invoke: async () => {
      throw new Error('provider down');
    },
  } as unknown as LLMDispatcher;
  const r = await runEntityHygiene(db, broken, { apply: true });
  assert.ok(r.groupsNominated > 0);
  assert.equal(r.groupsJudged, 0);
  assert.equal(loadEntities(db).length, before);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind='entity.hygiene'`).get() as {
    n: number;
  };
  assert.equal(n.n, 0);
  closeDb(db);
});

test('runEntityHygiene: an ungrounded canonical name falls back to the survivor name', async () => {
  const db = freshDb();
  seed(db);
  const r = await runEntityHygiene(
    db,
    fakeJudge(isAero, () => 'Velora Aero 60mm Super Wheelset', { n: 0 }),
    { apply: true },
  );
  const c = r.proposals.flatMap((p) => p.clusters).find((x) => x.canonical.includes('Aero'));
  assert.ok(c);
  assert.equal(c.canonical, c.keep.name);
  closeDb(db);
});

test('runEntityHygiene: renames the survivor to a grounded canonical not held by a member', async () => {
  const db = freshDb();
  const sam = upsertEntity(db, 'person', 'Sam Rivera');
  const a = upsertEntity(db, 'gear', 'C3');
  const b = upsertEntity(db, 'gear', 'Velora C 3');
  addRelation(db, sam.id, 'owns', a.id);
  addRelation(db, sam.id, 'uses', a.id);
  addRelation(db, sam.id, 'owns', b.id);
  const r = await runEntityHygiene(
    db,
    fakeJudge(
      (n) => (/C ?3/.test(n) ? 'c3' : null),
      () => 'Velora C3',
      { n: 0 },
    ),
    { apply: true },
  );
  assert.equal(r.merged, 1);
  const row = db
    .prepare(`SELECT canonical_name, normalized_name FROM entities WHERE id=?`)
    .get(a.id);
  assert.deepEqual(row, { canonical_name: 'Velora C3', normalized_name: 'velora c3' });
  const aliases = db.prepare(`SELECT alias FROM entity_aliases ORDER BY alias`).all();
  assert.deepEqual(aliases, [{ alias: 'c3' }, { alias: 'velora c 3' }]);
  closeDb(db);
});
