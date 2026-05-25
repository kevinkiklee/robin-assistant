// One-time entity cleanup: prune noise + merge case/type duplicates.
// Run: ROBIN_USER_DATA_DIR=./user-data node --import tsx scripts/cleanup-entities.mjs

import { isLowQualityEntity } from '../system/brain/cognition/biographer.ts';
import { closeDb, openDb } from '../system/brain/memory/db.ts';
import { dbFilePath, resolveUserDataDir } from '../system/lib/paths.ts';

const db = openDb(dbFilePath(resolveUserDataDir()));

const before = {
  entities: db.prepare('SELECT COUNT(*) c FROM entities').get().c,
  relations: db.prepare('SELECT COUNT(*) c FROM relations').get().c,
};

const allEntities = db.prepare('SELECT id, type, canonical_name FROM entities').all();

// Relation count per entity (for survivor selection)
const relCount = new Map();
for (const r of db.prepare('SELECT subject_id, object_id FROM relations').all()) {
  relCount.set(r.subject_id, (relCount.get(r.subject_id) ?? 0) + 1);
  relCount.set(r.object_id, (relCount.get(r.object_id) ?? 0) + 1);
}

db.exec('BEGIN');
let pruned = 0;
let merged = 0;

// 1. Prune noise entities (role markers, bare numbers, SHAs, state flags)
const repointSubj = db.prepare('UPDATE relations SET subject_id = ? WHERE subject_id = ?');
const repointObj = db.prepare('UPDATE relations SET object_id = ? WHERE object_id = ?');
const delRelsBoth = db.prepare('DELETE FROM relations WHERE subject_id = ? OR object_id = ?');
const delEntity = db.prepare('DELETE FROM entities WHERE id = ?');

const keepEntities = [];
for (const e of allEntities) {
  if (isLowQualityEntity(e.canonical_name)) {
    delRelsBoth.run(e.id, e.id);
    delEntity.run(e.id);
    pruned++;
  } else {
    keepEntities.push(e);
  }
}

// 2. Merge case/type duplicates: group by normalized (lowercased, trimmed) name
const groups = new Map();
for (const e of keepEntities) {
  const key = e.canonical_name.trim().toLowerCase();
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}

for (const [, group] of groups) {
  if (group.length < 2) continue;
  // Survivor = most relations; tie → most-specific type (non-generic) → lowest id
  const GENERIC = new Set(['thing', 'topic', 'concept']);
  group.sort((a, b) => {
    const ra = relCount.get(a.id) ?? 0;
    const rb = relCount.get(b.id) ?? 0;
    if (rb !== ra) return rb - ra;
    const ga = GENERIC.has(a.type) ? 1 : 0;
    const gb = GENERIC.has(b.type) ? 1 : 0;
    if (ga !== gb) return ga - gb; // prefer non-generic
    return a.id - b.id;
  });
  const survivor = group[0];
  for (const dup of group.slice(1)) {
    repointSubj.run(survivor.id, dup.id);
    repointObj.run(survivor.id, dup.id);
    delEntity.run(dup.id);
    merged++;
  }
}

// 3. Dedup relations created by the merge (same subject+predicate+object)
db.exec(`
  DELETE FROM relations WHERE id NOT IN (
    SELECT MIN(id) FROM relations GROUP BY subject_id, predicate, object_id
  )
`);
// Drop self-relations (subject == object) that merging may have created
db.exec('DELETE FROM relations WHERE subject_id = object_id');

db.exec('COMMIT');

const after = {
  entities: db.prepare('SELECT COUNT(*) c FROM entities').get().c,
  relations: db.prepare('SELECT COUNT(*) c FROM relations').get().c,
};

console.log(
  JSON.stringify(
    {
      pruned_noise: pruned,
      merged_duplicates: merged,
      entities: `${before.entities} -> ${after.entities}`,
      relations: `${before.relations} -> ${after.relations}`,
    },
    null,
    2,
  ),
);

// Show the leadforge/robin/kevin groups post-cleanup as a sanity check
for (const name of ['leadforge', 'robin', 'kevin']) {
  const rows = db
    .prepare(`SELECT id, type, canonical_name FROM entities WHERE lower(canonical_name) = ?`)
    .all(name);
  console.log(`${name}:`, rows.map((r) => `${r.canonical_name}(${r.type})`).join(', ') || '(none)');
}

closeDb(db);
