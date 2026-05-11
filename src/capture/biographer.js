// biographer.js — turns raw events into graph + memo emissions.
//
// Redesigned for the new schema (spec §11):
//   - Edges go through `store.relateAll([{ from, to, kind }])` against the
//     generic `edges` table. Registry validation is automatic.
//   - Entities go through `store.upsertEntity` (delegates to the 3-stage
//     cascade in `src/graph/upsert-entity.js`).
//   - Edge-kind renames applied: `co_occurs_with` → `occurs_with`,
//     `precedes` → `before`.
//   - When the biographer ever creates a memo (rare today), `derived_from`
//     edges back to the source event are emitted via `store.note`'s lineage.
//   - `events.biographed_at = time::now()` is still set on the processed event.

import { surql } from 'surrealdb';
import * as store from '../memory/store.js';
import { closeEpisode, createEpisode, findActiveEpisode } from '../graph/episodes.js';
import { validateBiographerOutput } from './biographer-output.js';
import { buildBiographerPrompt } from './biographer-prompt.js';

// Edge kinds the biographer is allowed to emit, normalized to the registry.
const ENTITY_EDGE_KINDS = new Set(['works_on', 'participates_in']);

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

async function invokeWithRetry(host, messages, opts, retries = 3, baseDelayMs = 1000) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await host.invokeLLM(messages, opts);
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1 && baseDelayMs > 0) {
        const delay = baseDelayMs * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function recordFailure(db, eventId, error) {
  await withTxRetry(async () => {
    await db
      .query(surql`
        UPSERT type::record('runtime', 'biographer')
        SET value.failed_event_ids = array::distinct(array::concat(value.failed_event_ids ?? [], [${String(eventId)}])),
            value.last_error = ${String(error.message)}
      `)
      .collect();
  });
}

export async function biographerProcess(db, embedder, host, eventId, opts = {}) {
  const retryBaseDelayMs = opts.retryBaseDelayMs ?? 1000;
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

  // 3. Invoke LLM (with retry)
  let response;
  try {
    response = await invokeWithRetry(
      host,
      messages,
      { tier: 'fast', json: true, system },
      3,
      retryBaseDelayMs,
    );
  } catch (e) {
    await recordFailure(db, eventId, e);
    throw e;
  }
  // 4. Validate output
  let output;
  try {
    output = JSON.parse(response.content);
    const validation = validateBiographerOutput(output);
    if (!validation.ok) throw new Error(`validation failed: ${validation.error}`);
  } catch (e) {
    await recordFailure(db, eventId, e);
    throw new Error(`biographer LLM returned malformed JSON: ${e.message}`);
  }

  // 4-5. Resolve / create entities through store.upsertEntity, which delegates
  // to the 3-stage cascade in src/graph/upsert-entity.js. Embedding rows land
  // in embeddings_<profile>_entities for the active profile.
  const nameToId = new Map();
  for (const ent of output.entities) {
    const r = await withTxRetry(() =>
      store.upsertEntity(db, embedder, {
        name: ent.name,
        type: ent.type,
        host,
        config,
      }),
    );
    nameToId.set(ent.name, r.id);
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

  // 7. Emit edges via store.relateAll. One batched call holds all kinds.
  const contextSnippet = (event.content ?? '').slice(0, 200);
  const edgeRows = [];
  // mentions: event → entity, one per resolved entity (plus context).
  for (const entity of output.entities) {
    const eid = nameToId.get(entity.name);
    if (!eid) continue;
    edgeRows.push({ from: eventId, to: eid, kind: 'mentions', context: contextSnippet });
  }
  // about: event → entity, for entities the LLM tagged as the subject.
  for (const aboutName of output.about) {
    const eid = nameToId.get(aboutName);
    if (eid) edgeRows.push({ from: eventId, to: eid, kind: 'about' });
  }
  // works_on / participates_in (entity → entity). The LLM emits edge.type
  // using the legacy name; we map it to the new registry name when needed.
  for (const edge of output.edges) {
    const kind = normalizeEdgeKind(edge.type);
    if (!kind) continue;
    const fromId = nameToId.get(edge.from);
    const toId = nameToId.get(edge.to);
    if (!fromId || !toId) continue;
    if (ENTITY_EDGE_KINDS.has(kind)) {
      edgeRows.push({ from: fromId, to: toId, kind });
    }
  }
  // occurs_with: every ordered pair among the entities (symmetric counter).
  // The registry canonicalizes endpoint order; store.relate UPSERTs by
  // composite ID and increments `weight` per call.
  const entityIds = Array.from(nameToId.values()).slice(0, config.cooccur_cap);
  for (let i = 0; i < entityIds.length; i++) {
    for (let j = i + 1; j < entityIds.length; j++) {
      edgeRows.push({ from: entityIds[i], to: entityIds[j], kind: 'occurs_with' });
    }
  }
  // before: optional event→event linkage (renamed from `precedes`).
  for (const edge of output.edges) {
    if (normalizeEdgeKind(edge.type) === 'before') {
      // `before` is event→event; biographer only sees a single event today,
      // so this is a no-op for now. Left here so future multi-event payloads
      // route through the same code path.
    }
  }

  if (edgeRows.length > 0) {
    await withTxRetry(() => store.relateAll(db, edgeRows));
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
    // Edges and entity upserts are idempotent (composite-ID UPSERT + stable
    // entity record IDs in the cascade), so the redundant writes are safe.
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

// Maps the LLM-facing edge type vocabulary to the EDGE_KIND_REGISTRY kind.
// Returns null for unknown/unsupported types so the caller can skip them.
function normalizeEdgeKind(t) {
  switch (t) {
    case 'mentions':
    case 'about':
    case 'works_on':
    case 'participates_in':
      return t;
    case 'co_occurs_with':
      return 'occurs_with';
    case 'precedes':
      return 'before';
    default:
      return null;
  }
}
