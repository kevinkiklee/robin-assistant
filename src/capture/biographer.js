import { surql } from 'surrealdb';
import { resolveEntity } from '../graph/cascade.js';
import {
  writeAboutEdge,
  writeCoOccursWith,
  writeMentionsEdge,
  writeTypedEntityEdge,
} from '../graph/edges.js';
import { closeEpisode, createEpisode, findActiveEpisode } from '../graph/episodes.js';
import { validateBiographerOutput } from './biographer-output.js';
import { buildBiographerPrompt } from './biographer-prompt.js';

const ENTITY_EDGE_TYPES = new Set(['works_on', 'participates_in']);

const DEFAULT_CONFIG = {
  stage2_high_threshold: 0.92,
  stage2_low_threshold: 0.8,
  episode_window_minutes: 30,
  catalog_size: 100,
  cooccur_cap: 8,
};

async function getCatalog(db, size) {
  const [rows] = await db
    .query(
      surql`SELECT name, type, created_at FROM entities ORDER BY created_at DESC LIMIT ${size}`,
    )
    .collect();
  return rows;
}

async function loadRuntime(db) {
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'biographer')`)
    .collect();
  return rows.length === 0 ? null : (rows[0]?.value ?? null);
}

// SurrealDB embedded engines surface "Transaction conflict: Write conflict"
// when two callers write the same record concurrently. The error is
// retryable — the engine asks us to retry the whole transaction. For our
// idempotent writes (UPSERT, gated UPDATE, check-then-RELATE) a small
// bounded retry loop converges parallel callers to a single resolved row.
const MAX_TX_RETRIES = 4;

function isTxConflict(err) {
  return String(err?.message ?? '').includes('Transaction conflict');
}

async function withTxRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_TX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTxConflict(e)) throw e;
      lastErr = e;
      // brief backoff with a jitter so paired callers desynchronise
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 10)));
    }
  }
  throw lastErr;
}

async function ensureRuntime(db) {
  const existing = await loadRuntime(db);
  if (existing?.config) return existing;
  const initial = { config: DEFAULT_CONFIG, entity_catalog_version: 0 };
  await withTxRetry(async () => {
    const current = await loadRuntime(db);
    if (current?.config) return;
    await db
      .query(surql`UPSERT type::record('runtime', 'biographer') SET value = ${initial}`)
      .collect();
  });
  return (await loadRuntime(db)) ?? initial;
}

export async function biographerProcess(db, embedder, host, eventId) {
  // 1. Read event; skip if already biographed
  const [eventRows] = await db.query(surql`SELECT * FROM ${eventId}`).collect();
  if (eventRows.length === 0) throw new Error(`event ${eventId} not found`);
  const event = eventRows[0];
  if (event.biographed_at) return { skipped: true, reason: 'already_biographed' };

  const runtime = await ensureRuntime(db);
  const config = runtime.config ?? DEFAULT_CONFIG;

  // 2. Build prompt
  const catalog = await getCatalog(db, config.catalog_size);
  const activeEpisode = await findActiveEpisode(db, event.source);
  const { system, messages } = buildBiographerPrompt({ event, catalog, activeEpisode });

  // 3. Invoke LLM
  const response = await host.invokeLLM(messages, { tier: 'fast', json: true, system });
  let output;
  try {
    output = JSON.parse(response.content);
  } catch (e) {
    throw new Error(`biographer LLM returned malformed JSON: ${e.message}`);
  }
  const validation = validateBiographerOutput(output);
  if (!validation.ok) {
    throw new Error(`biographer LLM output failed validation: ${validation.error}`);
  }

  // 4-5. Resolve / create entities. Creation uses a deterministic record id
  // keyed by (type, name_lower) and UPSERT, so two parallel biographer runs
  // on the same event converge to a single row instead of racing past Stage 1
  // and producing duplicates. Mirrors the stable-id pattern in writeCoOccursWith.
  const nameToId = new Map();
  for (const ent of output.entities) {
    const r = await resolveEntity(db, embedder, host, {
      name: ent.name,
      type: ent.type,
      config,
    });
    if (r.action === 'resolve') {
      nameToId.set(ent.name, r.entityId);
    } else {
      const vec = Array.from(await embedder.embed(`${ent.type}: ${ent.name}`));
      const stableKey = `${ent.type}__${ent.name.toLowerCase()}`;
      const row = await withTxRetry(async () => {
        const [upserted] = await db
          .query(
            surql`UPSERT type::record('entities', ${stableKey})
              SET name = ${ent.name}, type = ${ent.type}, embedding = ${vec}`,
          )
          .collect();
        return Array.isArray(upserted) ? upserted[0] : upserted;
      });
      nameToId.set(ent.name, row.id);
    }
  }

  // 6. Episode determination
  const eventTs = event.ts ? new Date(event.ts) : new Date();
  const lastEpisodeStart = activeEpisode?.started_at ? new Date(activeEpisode.started_at) : null;
  const minutesSinceStart = lastEpisodeStart
    ? (eventTs.getTime() - lastEpisodeStart.getTime()) / 60000
    : Number.POSITIVE_INFINITY;
  let episodeId;
  if (
    activeEpisode &&
    output.episode_continues_previous &&
    minutesSinceStart <= config.episode_window_minutes
  ) {
    episodeId = activeEpisode.id;
  } else {
    if (activeEpisode) {
      await closeEpisode(db, activeEpisode.id, {
        endedAt: eventTs,
        summary: output.episode_summary ?? undefined,
      });
    }
    const newEp = await createEpisode(db, { source: event.source });
    episodeId = newEp.id;
  }

  // 7. Write graph
  const contextSnippet = (event.content ?? '').slice(0, 200);
  for (const entity of output.entities) {
    const eid = nameToId.get(entity.name);
    if (!eid) continue;
    await writeMentionsEdge(db, eventId, eid, { context: contextSnippet });
  }
  for (const aboutName of output.about) {
    const eid = nameToId.get(aboutName);
    if (eid) await writeAboutEdge(db, eventId, eid);
  }
  for (const edge of output.edges) {
    if (ENTITY_EDGE_TYPES.has(edge.type)) {
      const fromId = nameToId.get(edge.from);
      const toId = nameToId.get(edge.to);
      if (fromId && toId) await writeTypedEntityEdge(db, fromId, edge.type, toId);
    }
  }
  const entityIds = Array.from(nameToId.values());
  if (entityIds.length >= 2) {
    await writeCoOccursWith(db, entityIds, { cap: config.cooccur_cap });
  }

  // 8. Mark event biographed
  const updated = await withTxRetry(async () => {
    const [rows] = await db
      .query(surql`
        UPDATE ${eventId}
          SET biographed_at = time::now(), episode_id = ${episodeId}
          WHERE biographed_at IS NONE
      `)
      .collect();
    return rows;
  });
  if (!updated || updated.length === 0) {
    // Lost the race — the other process biographed first.
    // Phase 2a: log and let the redundant writes stand (they're effectively idempotent
    // for entities thanks to stable record ids on entities and co_occurs_with).
    console.warn(`biographer race detected on ${eventId}; this run's writes may be redundant`);
  }

  // 9. Update runtime
  const nextRuntime = {
    ...runtime,
    last_processed_event_id: String(eventId),
    last_run_at: new Date(),
  };
  await withTxRetry(async () => {
    await db
      .query(surql`UPSERT type::record('runtime', 'biographer') SET value = ${nextRuntime}`)
      .collect();
  });

  return { processed: true, episodeId, entitiesCount: nameToId.size };
}
