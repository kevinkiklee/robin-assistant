// STALE — queries the deleted per-kind memo tables (knowledge, patterns,
// threads, predictions) and per-relation edge tables. The new schema uses
// `memos` (kind discriminator) and `edges` (kind discriminator). This file
// will be rewritten in a later wave once the DB browser UI is updated.
//
// View-tab data fetchers. Schema-aware (v2): entities/events/episodes/threads/
// knowledge/rules/patterns/profile/recall_events.

import { getAll, getOne, recordIdList, recordIdString } from './utils.js';

export async function getInfo(db, { TABLE_INFO, shortDescription } = {}) {
  const [info] = await db.query('INFO FOR DB').collect();
  const tables = Object.keys(info?.tables ?? {}).sort();
  const counts = {};
  const safe = tables.filter((t) => /^[a-z_][a-z0-9_]*$/i.test(t));
  if (safe.length) {
    const sql = safe.map((t) => `SELECT count() AS n FROM \`${t}\` GROUP ALL`).join(';\n');
    try {
      const responses = await db.query(sql).responses();
      responses.forEach((r, i) => {
        if (r.success && Array.isArray(r.result) && r.result[0]?.n != null) {
          counts[safe[i]] = r.result[0].n;
        }
      });
    } catch {
      /* counts are best-effort */
    }
  }
  const descriptions = {};
  if (shortDescription) {
    for (const t of tables) {
      const d = shortDescription(t);
      if (d) descriptions[t] = d;
    }
  }
  const layers = {};
  for (const t of tables) layers[t] = TABLE_INFO?.[t]?.layer ?? null;
  const populatesWhen = {};
  for (const t of tables) {
    if (TABLE_INFO?.[t]?.populates_when) populatesWhen[t] = TABLE_INFO[t].populates_when;
  }
  return { tables, counts, descriptions, layers, populates_when: populatesWhen };
}

export async function getTableInfo(db, table, { TABLE_INFO, compactFieldDef } = {}) {
  const meta = TABLE_INFO?.[table] ?? null;
  let schema = null;
  let count = null;
  if (/^[a-z_][a-z0-9_]*$/i.test(table)) {
    try {
      const [info] = await db.query(`INFO FOR TABLE \`${table}\``).collect();
      const fieldsRaw = info?.fields ?? {};
      const indexesRaw = info?.indexes ?? {};
      const fields = Object.entries(fieldsRaw)
        .filter(([k]) => !k.includes('.'))
        .map(([k, v]) => ({ name: k, def: compactFieldDef ? compactFieldDef(v, k, table) : v }));
      const indexes = Object.entries(indexesRaw).map(([k, v]) => ({ name: k, def: v }));
      schema = { fields, indexes };
    } catch (e) {
      schema = { error: String(e?.message ?? e) };
    }
    try {
      const [r] = await db.query(`SELECT count() AS n FROM \`${table}\` GROUP ALL`).collect();
      if (Array.isArray(r) && r[0]?.n != null) count = r[0].n;
      else if (r?.n != null) count = r.n;
    } catch {
      /* best-effort */
    }
  }
  return { name: table, count, meta, schema };
}

export async function runQuery(db, sql) {
  const t0 = performance.now();
  const responses = await db.query(sql).responses();
  const ms = +(performance.now() - t0).toFixed(1);
  return {
    ms,
    responses: responses.map((r) => ({
      success: r.success,
      result: r.success ? r.result : undefined,
      error: r.success ? undefined : String(r.error?.message ?? r.error ?? 'unknown error'),
      stats: r.stats,
    })),
  };
}

// ===== View tab data =====

export async function getDashboard(db) {
  const t0 = performance.now();

  // Profile row. v2 uses a singleton `profile` table; tolerate either a known
  // record id or just "any row".
  const userProfile = (await getOne(db, 'SELECT * FROM profile LIMIT 1')) ?? null;
  const userName = userProfile?.name ?? null;

  const userEntity = userName
    ? await getOne(
        db,
        'SELECT id, slug, name, kind, summary, updated FROM entities WHERE name = $name LIMIT 1',
        { name: userName },
      )
    : null;

  const lastEventRow = await getOne(db, 'SELECT ts FROM events ORDER BY ts DESC LIMIT 1');
  const lastEventTs = lastEventRow?.ts ?? null;

  // Recently active entities: any entity mentioned (or about-ed) by an event in
  // the last 14 days. SurrealQL has no UNION in FROM subquery, so we collect
  // both edge tables separately and merge in JS.
  const mentionsRecent = await getAll(
    db,
    'SELECT (->mentions->entities) AS ents, ts AS at FROM events WHERE ts >= time::now() - 14d',
  );
  const aboutRecent = await getAll(
    db,
    'SELECT (->about->entities) AS ents, ts AS at FROM events WHERE ts >= time::now() - 14d',
  );
  const lastByEntity = new Map();
  for (const row of [...mentionsRecent, ...aboutRecent]) {
    const at = row.at;
    for (const ent of row.ents ?? []) {
      const key = recordIdString(ent);
      if (!key) continue;
      const cur = lastByEntity.get(key);
      if (!cur || new Date(at) > new Date(cur)) lastByEntity.set(key, at);
    }
  }
  const recentlyActiveRaw = [...lastByEntity.entries()]
    .sort((a, b) => new Date(b[1]) - new Date(a[1]))
    .slice(0, 12)
    .map(([entity, last_activity_ts]) => ({ entity, last_activity_ts }));
  const entityIds = recentlyActiveRaw.map((r) => r.entity).filter(Boolean);
  let recentlyActive = [];
  if (entityIds.length) {
    const idList = recordIdList('entities', entityIds);
    const ents = await getAll(
      db,
      `SELECT id, slug, name, kind, summary FROM entities WHERE id IN ${idList}`,
    );
    const byId = new Map(ents.map((e) => [String(e.id), e]));
    recentlyActive = recentlyActiveRaw
      .map((r) => {
        const e = byId.get(r.entity);
        if (!e) return null;
        return {
          slug: e.slug,
          name: e.name,
          kind: e.kind,
          last_activity_ts: r.last_activity_ts,
          last_activity_summary: (e.summary ?? '').slice(0, 200),
        };
      })
      .filter(Boolean);
  }

  const recentActivity = await getAll(
    db,
    'SELECT id, ts, content, source, meta FROM events ORDER BY ts DESC LIMIT 25',
  );

  const pendingRules = await getAll(
    db,
    "SELECT id, directive, rationale, created FROM rule_candidates WHERE status = 'pending' ORDER BY created DESC LIMIT 5",
  );
  const recentRefusals = await getAll(
    db,
    'SELECT id, ts, surface, action, reason FROM refusals ORDER BY ts DESC LIMIT 5',
  );

  const info = await getInfo(db);

  let factsCount = 0;
  if (userEntity) {
    const fc = await getOne(
      db,
      'SELECT count() AS n FROM events WHERE $eid IN ->mentions->entities OR $eid IN ->about->entities GROUP ALL',
      { eid: userEntity.id },
    );
    factsCount = fc?.n ?? 0;
  }

  return {
    user: userEntity
      ? {
          name: userEntity.name,
          slug: userEntity.slug,
          facts_count: factsCount,
          knowledge_count: info.counts.knowledge ?? 0,
          active_rules_count: info.counts.rules ?? 0,
          pending_candidates_count: info.counts.rule_candidates ?? 0,
          summary: userEntity.summary,
          last_synthesized_at: userEntity.updated,
        }
      : null,
    last_capture_ts: lastEventTs,
    recently_active: recentlyActive,
    recent_activity: recentActivity,
    needs_input: {
      pending_rules: pendingRules,
      recent_refusals: recentRefusals,
    },
    counts: info.counts,
    ms: +(performance.now() - t0).toFixed(1),
  };
}

export async function getEntitySearch(db, q) {
  const t0 = performance.now();
  if (!q) return { results: [], ms: 0 };
  const results = await getAll(
    db,
    'SELECT slug, name, kind FROM entities WHERE string::lowercase(name) CONTAINS string::lowercase($q) OR $q IN aliases LIMIT 10',
    { q },
  );
  return { results, ms: +(performance.now() - t0).toFixed(1) };
}

export async function getEntityProfile(db, slug) {
  const t0 = performance.now();
  const entity = await getOne(
    db,
    'SELECT id, slug, name, kind, summary, aliases, created, updated FROM entities WHERE slug = $slug LIMIT 1',
    { slug },
  );
  if (!entity) return null;

  const recentEvents = await getAll(
    db,
    'SELECT id, ts, content, source FROM events WHERE $eid IN ->mentions->entities OR $eid IN ->about->entities ORDER BY ts DESC LIMIT 25',
    { eid: entity.id },
  );

  const connectedRaw = await getAll(
    db,
    'SELECT (->mentions->entities) AS ents FROM events WHERE $eid IN ->mentions->entities LIMIT 25',
    { eid: entity.id },
  );
  const connectedIds = new Set();
  const selfId = String(entity.id);
  for (const row of connectedRaw) {
    for (const e of row.ents ?? []) {
      const idStr = recordIdString(e);
      if (idStr && idStr !== selfId) connectedIds.add(idStr);
    }
  }
  let connected = [];
  if (connectedIds.size) {
    const idList = recordIdList('entities', [...connectedIds]);
    connected = await getAll(
      db,
      `SELECT slug, name, kind FROM entities WHERE id IN ${idList} LIMIT 12`,
    );
  }

  // Knowledge rows naming this entity (best-effort substring match against
  // canonical name; v2's knowledge schema does not currently carry a strict
  // entity-fk, so we fall back to text containment).
  const knowledge = await getAll(
    db,
    'SELECT id, topic, content, created FROM knowledge WHERE string::lowercase(content) CONTAINS string::lowercase($name) ORDER BY created DESC LIMIT 10',
    { name: entity.name },
  );

  return {
    entity,
    recent_events: recentEvents,
    connected_entities: connected,
    knowledge,
    ms: +(performance.now() - t0).toFixed(1),
  };
}

// Analysis cards — each returns its own shape.
const ANALYSIS_CARDS = {
  'top-entities': async (db) => {
    const fromMentions = await getAll(
      db,
      'SELECT (->mentions->entities) AS ents FROM events WHERE ts >= time::now() - 90d',
    );
    const fromAbout = await getAll(
      db,
      'SELECT (->about->entities) AS ents FROM events WHERE ts >= time::now() - 90d',
    );
    const counts = new Map();
    for (const row of [...fromMentions, ...fromAbout]) {
      for (const ent of row.ents ?? []) {
        const key = recordIdString(ent);
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const rows = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([entity, n]) => ({ entity, n }));
    const ids = rows.map((r) => r.entity).filter(Boolean);
    if (!ids.length) return { entities: [] };
    const idList = recordIdList('entities', ids);
    const ents = await getAll(
      db,
      `SELECT id, slug, name, kind FROM entities WHERE id IN ${idList}`,
    );
    const byId = new Map(ents.map((e) => [String(e.id), e]));
    const entities = rows
      .map((r) => {
        const e = byId.get(r.entity);
        return e ? { slug: e.slug, name: e.name, kind: e.kind, count: r.n } : null;
      })
      .filter(Boolean);
    return { entities };
  },

  'knowledge-by-topic': async (db) => {
    const rows = await getAll(
      db,
      "SELECT topic ?? 'uncategorized' AS topic, count() AS n FROM knowledge GROUP BY topic ORDER BY n DESC LIMIT 30",
    );
    return { rows };
  },

  'rules-by-scope': async (db) => {
    const rows = await getAll(
      db,
      "SELECT scope ?? 'base' AS scope, state, count() AS n FROM rules GROUP BY scope, state ORDER BY n DESC",
    );
    return { rows };
  },

  'refusals-by-surface': async (db) => {
    const rows = await getAll(
      db,
      "SELECT surface ?? 'unknown' AS surface, count() AS n FROM refusals WHERE ts >= time::now() - 90d GROUP BY surface ORDER BY n DESC LIMIT 10",
    );
    return { rows };
  },

  'recall-usefulness': async (db) => {
    const total =
      (
        await getOne(
          db,
          'SELECT count() AS n FROM recall_events WHERE ts >= time::now() - 30d GROUP ALL',
        )
      )?.n ?? 0;
    const used =
      (
        await getOne(
          db,
          'SELECT count() AS n FROM recall_events WHERE ts >= time::now() - 30d AND used_at IS NOT NONE GROUP ALL',
        )
      )?.n ?? 0;
    return { total, used, unused: Math.max(0, total - used) };
  },
};

export async function getAnalysisCard(db, card) {
  const fn = ANALYSIS_CARDS[card];
  if (!fn) return null;
  const t0 = performance.now();
  const data = await fn(db);
  return { ...data, ms: +(performance.now() - t0).toFixed(1) };
}

// Trends — bucket helpers
function rangeToDays(s) {
  if (s === '30d') return 30;
  if (s === '90d') return 90;
  if (s === '1y') return 365;
  if (s === 'all') return 99999;
  return 90;
}
function chooseBucket(rangeDays) {
  if (rangeDays <= 30) return { name: 'day', expr: (col) => `time::format(${col}, '%Y-%m-%d')` };
  if (rangeDays > 365) return { name: 'month', expr: (col) => `time::format(${col}, '%Y-%m')` };
  return { name: 'week', expr: (col) => `time::format(${col}, '%Y-W%V')` };
}

const TREND_METRICS = {
  'activity-pulse': async (db, range) => {
    const days = rangeToDays(range);
    const b = chooseBucket(days);
    const rows = await getAll(
      db,
      `SELECT ${b.expr('ts')} AS bucket, count() AS n FROM events WHERE ts >= time::now() - ${days}d GROUP BY bucket ORDER BY bucket`,
    );
    return {
      bucket: b.name,
      series: [
        { name: 'events', points: rows.map((r) => ({ bucket: String(r.bucket), value: r.n })) },
      ],
    };
  },
  'knowledge-growth': async (db, range) => {
    const days = rangeToDays(range);
    const b = chooseBucket(days);
    const ents = await getAll(
      db,
      `SELECT ${b.expr('created')} AS bucket, count() AS n FROM entities WHERE created >= time::now() - ${days}d GROUP BY bucket ORDER BY bucket`,
    );
    const know = await getAll(
      db,
      `SELECT ${b.expr('created')} AS bucket, count() AS n FROM knowledge WHERE created >= time::now() - ${days}d GROUP BY bucket ORDER BY bucket`,
    );
    return {
      bucket: b.name,
      series: [
        { name: 'entities', points: ents.map((r) => ({ bucket: String(r.bucket), value: r.n })) },
        { name: 'knowledge', points: know.map((r) => ({ bucket: String(r.bucket), value: r.n })) },
      ],
    };
  },
  'event-source-mix': async (db, range) => {
    const days = rangeToDays(range);
    const b = chooseBucket(days);
    const rows = await getAll(
      db,
      `SELECT ${b.expr('ts')} AS bucket, source, count() AS n FROM events WHERE ts >= time::now() - ${days}d GROUP BY bucket, source ORDER BY bucket`,
    );
    const buckets = new Map();
    const seenSources = new Set();
    for (const r of rows) {
      const k = String(r.bucket);
      const src = r.source ?? 'unknown';
      seenSources.add(src);
      if (!buckets.has(k)) buckets.set(k, {});
      buckets.get(k)[src] = (buckets.get(k)[src] ?? 0) + r.n;
    }
    const series = [...seenSources].sort();
    return {
      bucket: b.name,
      series,
      points: [...buckets.entries()].sort().map(([k, v]) => ({ bucket: k, values: v })),
    };
  },
  'refusals-rate': async (db, range) => {
    const days = rangeToDays(range);
    const b = chooseBucket(days);
    const rows = await getAll(
      db,
      `SELECT ${b.expr('ts')} AS bucket, count() AS n FROM refusals WHERE ts >= time::now() - ${days}d GROUP BY bucket ORDER BY bucket`,
    );
    return {
      bucket: b.name,
      series: [
        { name: 'refusals', points: rows.map((r) => ({ bucket: String(r.bucket), value: r.n })) },
      ],
    };
  },
  'top-entity-engagement': async (db, range) => {
    const days = rangeToDays(range);
    const b = chooseBucket(days);
    const allMentions = await getAll(db, 'SELECT (->mentions->entities) AS ents FROM events');
    const counts = new Map();
    for (const row of allMentions) {
      for (const ent of row.ents ?? []) {
        const k = recordIdString(ent);
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    const ids = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);
    if (!ids.length) return { bucket: b.name, series: [] };
    const idList = recordIdList('entities', ids);
    const ents = await getAll(db, `SELECT id, slug, name FROM entities WHERE id IN ${idList}`);
    const series = await Promise.all(
      ents.map(async (e) => {
        const rows = await getAll(
          db,
          `SELECT ${b.expr('ts')} AS bucket, count() AS n FROM events WHERE ts >= time::now() - ${days}d AND $eid IN ->mentions->entities GROUP BY bucket ORDER BY bucket`,
          { eid: e.id },
        );
        return {
          name: e.name,
          slug: e.slug,
          points: rows.map((r) => ({ bucket: String(r.bucket), value: r.n })),
        };
      }),
    );
    return { bucket: b.name, series };
  },
};

export async function getTrend(db, metric, range) {
  const fn = TREND_METRICS[metric];
  if (!fn) return null;
  const t0 = performance.now();
  const data = await fn(db, range);
  return { metric, range, ...data, ms: +(performance.now() - t0).toFixed(1) };
}
