import type { RobinDb } from './db.ts';

// ─── Entity merge / dedup ─────────────────────────────────────────────────────
// Consolidate duplicate entities (e.g. "Kevin K. Lee" + "Kevin Lee" → one node)
// by re-pointing every relation from the dropped entities onto a surviving
// canonical, coalescing profiles, and collapsing the duplicate edges the merge
// creates. Designed to be PREVIEWED before it runs: `mergeEntities(db, refs)`
// computes the full scale (entities removed, relations re-pointed, duplicate
// edges collapsed, self-loops removed) WITHOUT mutating; pass `{ apply: true }`
// to execute the same plan in a single transaction.

export interface MergeGroupRef {
  /** Surviving canonical — an entity id, or a "<type>:<canonical_name>" string. */
  keep: string | number;
  /** Entities merged into `keep` and then deleted. */
  drops: Array<string | number>;
}

interface EntityRow {
  id: number;
  type: string;
  canonical_name: string;
  profile: string | null;
}

export interface GroupPlan {
  keep: EntityRow;
  drops: EntityRow[];
  relationsRepointed: number;
  relationsDeduped: number;
  selfLoopsRemoved: number;
}

export interface MergePlan {
  groups: GroupPlan[];
  totals: {
    entitiesRemoved: number;
    relationsRepointed: number;
    relationsDeduped: number;
    selfLoopsRemoved: number;
  };
  applied: boolean;
}

/** Resolve an `<id>` or `"<type>:<canonical_name>"` ref to its entity row. Throws if absent. */
export function resolveEntityRef(db: RobinDb, ref: string | number): EntityRow {
  if (typeof ref === 'number' || /^\d+$/.test(ref)) {
    const row = db
      .prepare('SELECT id, type, canonical_name, profile FROM entities WHERE id=?')
      .get(Number(ref)) as EntityRow | undefined;
    if (!row) throw new Error(`no entity with id ${ref}`);
    return row;
  }
  const idx = String(ref).indexOf(':');
  if (idx === -1) throw new Error(`entity ref must be <id> or <type>:<name>, got "${ref}"`);
  const type = String(ref).slice(0, idx).trim();
  const name = String(ref)
    .slice(idx + 1)
    .trim();
  const row = db
    .prepare(
      'SELECT id, type, canonical_name, profile FROM entities WHERE type=? AND canonical_name=?',
    )
    .get(type, name) as EntityRow | undefined;
  if (!row) throw new Error(`no entity ${type}:${name}`);
  return row;
}

/** Pre-merge neighborhood of every entity in `refs` — relations touching any keep
 *  or drop. Persist this before applying to make a merge reversible. */
export function collectMergeSnapshot(db: RobinDb, refs: MergeGroupRef[]): unknown[] {
  const out: unknown[] = [];
  const relStmt = db.prepare(
    'SELECT id, subject_id, predicate, object_id, ts, source_event_id, import_key FROM relations WHERE subject_id=? OR object_id=?',
  );
  for (const g of refs) {
    const keep = resolveEntityRef(db, g.keep);
    for (const dropRef of g.drops) {
      const drop = resolveEntityRef(db, dropRef);
      out.push({ keep: keep.id, drop, relations: relStmt.all(drop.id, drop.id) });
    }
    out.push({ keep, relations: relStmt.all(keep.id, keep.id) });
  }
  return out;
}

export function mergeEntities(
  db: RobinDb,
  refs: MergeGroupRef[],
  opts: { apply?: boolean } = {},
): MergePlan {
  const groups = refs.map((g) => ({
    keep: resolveEntityRef(db, g.keep),
    drops: g.drops.map((d) => resolveEntityRef(db, d)),
  }));

  // Validation — reject chained merges (a drop that is another group's keep), a
  // keep listed as its own drop, and a drop repeated across groups. These would
  // silently lose data or depend on execution order.
  const keepIds = new Set(groups.map((g) => g.keep.id));
  const seenDrops = new Set<number>();
  for (const g of groups) {
    for (const d of g.drops) {
      if (d.id === g.keep.id)
        throw new Error(`"${g.keep.canonical_name}": keep id ${d.id} listed as its own drop`);
      if (keepIds.has(d.id))
        throw new Error(
          `drop ${d.id} (${d.canonical_name}) is also a keep elsewhere — chained merges are not allowed; split into two passes`,
        );
      if (seenDrops.has(d.id))
        throw new Error(`drop ${d.id} (${d.canonical_name}) appears in more than one group`);
      seenDrops.add(d.id);
    }
  }

  // Compute the exact plan (this math is identical whether or not we apply).
  const plans: GroupPlan[] = groups.map((g) => {
    const ids = [g.keep.id, ...g.drops.map((d) => d.id)];
    const dropIds = new Set(g.drops.map((d) => d.id));
    const ph = ids.map(() => '?').join(',');
    const rels = db
      .prepare(
        `SELECT subject_id, predicate, object_id FROM relations WHERE subject_id IN (${ph}) OR object_id IN (${ph})`,
      )
      .all(...ids, ...ids) as Array<{ subject_id: number; predicate: string; object_id: number }>;
    const map = (x: number) => (dropIds.has(x) ? g.keep.id : x);
    let relationsRepointed = 0;
    let selfLoopsRemoved = 0;
    let nonLoop = 0;
    const triples = new Set<string>();
    for (const r of rels) {
      if (dropIds.has(r.subject_id) || dropIds.has(r.object_id)) relationsRepointed++;
      const s = map(r.subject_id);
      const o = map(r.object_id);
      if (s === o) {
        selfLoopsRemoved++;
        continue;
      }
      nonLoop++;
      triples.add(`${s}|${r.predicate}|${o}`);
    }
    return {
      keep: g.keep,
      drops: g.drops,
      relationsRepointed,
      relationsDeduped: nonLoop - triples.size,
      selfLoopsRemoved,
    };
  });

  const totals = {
    entitiesRemoved: plans.reduce((n, p) => n + p.drops.length, 0),
    relationsRepointed: plans.reduce((n, p) => n + p.relationsRepointed, 0),
    relationsDeduped: plans.reduce((n, p) => n + p.relationsDeduped, 0),
    selfLoopsRemoved: plans.reduce((n, p) => n + p.selfLoopsRemoved, 0),
  };

  if (!opts.apply) return { groups: plans, totals, applied: false };

  const repointSubj = db.prepare('UPDATE relations SET subject_id=? WHERE subject_id=?');
  const repointObj = db.prepare('UPDATE relations SET object_id=? WHERE object_id=?');
  const setProfile = db.prepare(
    // Stamp profile_generated_at too: a copied profile is being (re)published as
    // current — an unstamped one would read as stale at the MCP boundary.
    "UPDATE entities SET profile=?, profile_generated_at=datetime('now'), updated_at=datetime('now') WHERE id=?",
  );
  const delEntity = db.prepare('DELETE FROM entities WHERE id=?');
  const delSelfLoops = db.prepare('DELETE FROM relations WHERE subject_id=? AND object_id=?');
  // Collapse the duplicate (s,p,o) edges the merge produced, keeping the earliest row.
  const dedup = db.prepare(`
    DELETE FROM relations
    WHERE (subject_id=? OR object_id=?)
      AND id NOT IN (SELECT MIN(id) FROM relations GROUP BY subject_id, predicate, object_id)
  `);

  db.transaction(() => {
    for (const g of groups) {
      // Re-point first so the drop has no referencing relations when deleted
      // (nothing is lost to ON DELETE CASCADE).
      let keepProfile = g.keep.profile;
      for (const d of g.drops) {
        repointSubj.run(g.keep.id, d.id);
        repointObj.run(g.keep.id, d.id);
        if (!keepProfile && d.profile) {
          setProfile.run(d.profile, g.keep.id);
          keepProfile = d.profile;
        }
        delEntity.run(d.id);
      }
      delSelfLoops.run(g.keep.id, g.keep.id);
      dedup.run(g.keep.id, g.keep.id);
    }
  })();

  return { groups: plans, totals, applied: true };
}
