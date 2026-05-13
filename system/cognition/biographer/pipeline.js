// biographer.js — turns raw events into graph + memo emissions.
//
// Redesigned for the new schema (spec §11):
//   - Edges go through `store.relateAll([{ from, to, kind }])` against the
//     generic `edges` table. Registry validation is automatic.
//   - Entities go through `store.upsertEntity` (delegates to the 3-stage
//     cascade in `cognition/biographer/upsert-entity.js`).
//   - Edge-kind renames applied: `co_occurs_with` → `occurs_with`,
//     `precedes` → `before`.
//   - When the biographer ever creates a memo (rare today), `derived_from`
//     edges back to the source event are emitted via `store.note`'s lineage.
//   - `events.biographed_at = time::now()` is still set on the processed event.

import { surql } from 'surrealdb';
import { recordIdFromString } from '../memory/edge-registry.js';
import { closeEpisode, createEpisode, findActiveEpisode } from '../memory/episodes.js';
import * as store from '../memory/store.js';
import { withTxRetry } from '../memory/tx.js';
import { validateBiographerBatchOutput } from './batch-output.js';
import { buildBiographerBatchPrompt } from './batch-prompt.js';
import { parseLLMJSON, validateBiographerOutput } from './output.js';
import { buildBiographerPrompt } from './prompt.js';

// Edge kinds the biographer is allowed to emit, normalized to the registry.
const ENTITY_EDGE_KINDS = new Set(['works_on', 'participates_in']);

const DEFAULT_CONFIG = {
  stage2_high_threshold: 0.92,
  stage2_low_threshold: 0.8,
  episode_window_minutes: 30,
  catalog_size: 100,
  cooccur_cap: 8,
};

export const DEFAULT_BATCH_CONFIG = {
  max_batch_size: 8,
  debounce_ms: 750,
  max_wait_ms: 3000,
  disable: false,
};

// Per-db cache for readBatchConfig. Using a WeakMap keyed on the db handle
// scopes the 5s TTL cache per-connection so concurrent test databases
// don't share stale snapshots.
const _batchConfigCache = new WeakMap();
const BATCH_CONFIG_TTL_MS = 5000;

export async function readBatchConfig(db) {
  const cached = _batchConfigCache.get(db);
  const now = Date.now();
  if (cached && now - cached.at < BATCH_CONFIG_TTL_MS) {
    return cached.value;
  }
  const runtime = await loadRuntime(db);
  const stored = runtime?.batch_config ?? {};
  const cfg = { ...DEFAULT_BATCH_CONFIG, ...stored };
  _batchConfigCache.set(db, { value: cfg, at: now });
  return cfg;
}

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

async function ensureRuntime(db) {
  const existing = await loadRuntime(db);
  if (existing?.config && existing?.batch_config) return existing;
  await withTxRetry(async () => {
    const current = await loadRuntime(db);
    if (current?.config && current?.batch_config) return;
    const merged = {
      ...(current ?? {}),
      config: current?.config ?? DEFAULT_CONFIG,
      batch_config: current?.batch_config ?? DEFAULT_BATCH_CONFIG,
      entity_catalog_version: current?.entity_catalog_version ?? 0,
    };
    await db
      .query(surql`UPSERT type::record('runtime', 'biographer') SET value = ${merged}`)
      .collect();
  });
  return (
    (await loadRuntime(db)) ?? {
      config: DEFAULT_CONFIG,
      batch_config: DEFAULT_BATCH_CONFIG,
      entity_catalog_version: 0,
    }
  );
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
  const r = await biographerProcessBatch(db, embedder, host, [eventId], opts);
  return r.perEvent.get(String(eventId)) ?? { skipped: true, reason: 'unknown' };
}

export async function biographerProcessBatch(db, embedder, host, eventIds, opts = {}) {
  const perEvent = new Map();
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return { perEvent };
  }
  // Normalize ids: callers (queue accumulator, MCP handlers, CLI) may pass
  // either "table:id" strings or SDK RecordId objects. The surql template
  // tag binds plain strings as string LITERALS, so `SELECT * FROM ${strId}`
  // returns garbage (string-indexed chars) instead of the row. Always pass
  // RecordId here so internal SELECTs hit the right record.
  eventIds = eventIds.map(recordIdFromString);
  const batchStartedAt = Date.now();

  // 1. Single-event fast path stays as-is — short-circuits to _processOne for
  //    behaviour-identical N=1 calls (MCP-tool callers, biographer-catchup CLI).
  //    Batch overhead saves nothing at N=1 and would change observable counter
  //    semantics (per-event recordFailure shapes).
  if (eventIds.length === 1) {
    try {
      const r = await _processOne(db, embedder, host, eventIds[0], opts);
      perEvent.set(String(eventIds[0]), r);
    } catch (e) {
      perEvent.set(String(eventIds[0]), { failed: true, error: e.message });
      throw e;
    }
    return { perEvent };
  }

  const retryBaseDelayMs = opts.retryBaseDelayMs ?? 1000;
  const runtime = await ensureRuntime(db);
  const config = runtime.config ?? DEFAULT_CONFIG;

  // 2. Load events; filter out already-biographed. Use SELECT-per-id since the
  //    SurrealDB JS SDK's surql tag for RecordId arrays in IN clauses needs
  //    careful handling — per-id SELECTs are still one round-trip each but
  //    avoid binding-encoding hazards. Total round-trips are still N+1 vs the
  //    old N×(many) shape.
  const events = [];
  for (const id of eventIds) {
    const [rows] = await db.query(surql`SELECT * FROM ${id}`).collect();
    if (rows.length > 0) events.push(rows[0]);
  }
  const toProcess = events
    .filter((ev) => !ev.biographed_at)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  for (const ev of events) {
    if (ev.biographed_at) {
      perEvent.set(String(ev.id), { skipped: true, reason: 'already_biographed' });
    }
  }
  if (toProcess.length === 0) return { perEvent };

  // 3. Build prompt; the active episode + catalog are read once per batch.
  const source = toProcess[0].source;
  const catalog = await getCatalog(db, config.catalog_size);
  const activeEpisode = await findActiveEpisode(db, source);
  const { system, messages } = buildBiographerBatchPrompt({
    events: toProcess,
    catalog,
    activeEpisode,
  });

  // 4. Invoke LLM (one call for the whole batch). On retries-exhausted /
  //    parse failure / batch-validation failure, fall back to per-event
  //    single-call processing (§8).
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
    await _recordBatchFallback(db, 'network');
    return _fallbackPerEvent(
      db,
      embedder,
      host,
      toProcess.map((ev) => ev.id),
      perEvent,
      opts,
      e,
    );
  }
  let parsed;
  try {
    parsed = parseLLMJSON(response.content);
  } catch (e) {
    await _recordBatchFallback(db, 'outer_json');
    return _fallbackPerEvent(
      db,
      embedder,
      host,
      toProcess.map((ev) => ev.id),
      perEvent,
      opts,
      e,
    );
  }
  const expectedIds = toProcess.map((ev) => String(ev.id));
  const validation = validateBiographerBatchOutput(parsed, expectedIds);
  if (!validation.ok) {
    await _recordBatchFallback(db, 'batch_validation');
    return _fallbackPerEvent(
      db,
      embedder,
      host,
      toProcess.map((ev) => ev.id),
      perEvent,
      opts,
      new Error(validation.error),
    );
  }

  // 5. Per-entry failure handling — record missing/malformed via recordFailure
  //    with kind-prefixed messages so `value.last_error` retains the cause.
  for (const id of validation.missing) {
    const msg = `missing_in_batch_output: ${id}`;
    await recordFailure(db, id, new Error(msg));
    perEvent.set(id, { failed: true, error: msg });
  }
  for (const { event_id, error } of validation.malformed) {
    if (event_id !== '<missing event_id>') {
      const msg = `batch_malformed: ${error}`;
      await recordFailure(db, event_id, new Error(msg));
      perEvent.set(event_id, { failed: true, error: msg });
    }
  }

  const validEvents = toProcess.filter((ev) => validation.events.has(String(ev.id)));
  if (validEvents.length === 0) {
    await _recordBatchTelemetry(db, { batches_total_delta: 1 });
    return { perEvent };
  }

  // 6. Entity cascade dedup across the whole batch (spec §5).
  //    Collect unique (type, name_lower) keys; resolve once each via
  //    store.upsertEntity (which runs the existing 3-stage cascade).
  const desiredEntities = new Map(); // key -> { name, type }
  for (const ev of validEvents) {
    const perOut = validation.events.get(String(ev.id));
    for (const ent of perOut.entities) {
      const key = `${ent.type}__${ent.name.toLowerCase()}`;
      if (!desiredEntities.has(key)) desiredEntities.set(key, { name: ent.name, type: ent.type });
    }
  }
  const keyToId = new Map();
  for (const [key, { name, type }] of desiredEntities) {
    const r = await withTxRetry(() =>
      store.upsertEntity(db, embedder, { name, type, host, config }),
    );
    keyToId.set(key, r.id);
  }

  // 7. Episode determination across the batch (spec §4).
  //    Walk events in ts-ascending order; carry currentEpisodeId; close+open
  //    in-loop without re-querying the DB.
  let currentEpisodeId = activeEpisode?.id ?? null;
  let lastEpisodeStart = activeEpisode?.started_at ? new Date(activeEpisode.started_at) : null;
  const episodeIdForEvent = new Map();
  for (const ev of validEvents) {
    const perOut = validation.events.get(String(ev.id));
    const eventTs = ev.ts ? new Date(ev.ts) : new Date();
    const llmSaysContinues = perOut.episode_continues_previous === true;
    const withinWindow =
      currentEpisodeId && lastEpisodeStart
        ? (eventTs.getTime() - lastEpisodeStart.getTime()) / 60000 <= config.episode_window_minutes
        : false;
    if (currentEpisodeId && llmSaysContinues && withinWindow) {
      episodeIdForEvent.set(String(ev.id), currentEpisodeId);
    } else {
      if (currentEpisodeId) {
        await closeEpisode(db, currentEpisodeId, {
          endedAt: eventTs,
          summary: perOut.episode_summary ?? undefined,
        });
      }
      const newEp = await createEpisode(db, { source: ev.source });
      currentEpisodeId = newEp.id;
      lastEpisodeStart = eventTs;
      episodeIdForEvent.set(String(ev.id), currentEpisodeId);
    }
  }

  // 8. Edge collection (spec §6). Per-event scope for mentions/about/edges
  //    /occurs_with; within-batch `before` chained inside each episode group.
  const edgeRows = [];
  const evidenceJobs = [];
  for (const ev of validEvents) {
    const perOut = validation.events.get(String(ev.id));
    const contextSnippet = (ev.content ?? '').slice(0, 200);
    const nameToId = new Map();
    for (const ent of perOut.entities) {
      const key = `${ent.type}__${ent.name.toLowerCase()}`;
      const id = keyToId.get(key);
      if (id) nameToId.set(ent.name, id);
    }
    for (const ent of perOut.entities) {
      const eid = nameToId.get(ent.name);
      if (eid) edgeRows.push({ from: ev.id, to: eid, kind: 'mentions', context: contextSnippet });
    }
    for (const aboutName of perOut.about) {
      const eid = nameToId.get(aboutName);
      if (eid) edgeRows.push({ from: ev.id, to: eid, kind: 'about' });
    }
    for (const edge of perOut.edges) {
      const kind = normalizeEdgeKind(edge.type);
      if (!kind) continue;
      const fromId = nameToId.get(edge.from);
      const toId = nameToId.get(edge.to);
      if (!fromId || !toId) continue;
      if (ENTITY_EDGE_KINDS.has(kind)) {
        edgeRows.push({ from: fromId, to: toId, kind });
      }
    }
    const entityIds = Array.from(nameToId.values()).slice(0, config.cooccur_cap);
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        edgeRows.push({ from: entityIds[i], to: entityIds[j], kind: 'occurs_with' });
      }
    }
    if (Array.isArray(perOut.evidence_signals) && perOut.evidence_signals.length > 0) {
      evidenceJobs.push({ ev, signals: perOut.evidence_signals });
    }
  }

  // within-batch `before` edges: group by episodeIdForEvent, chain in ts asc.
  const byEpisode = new Map();
  for (const ev of validEvents) {
    const epId = String(episodeIdForEvent.get(String(ev.id)));
    if (!byEpisode.has(epId)) byEpisode.set(epId, []);
    byEpisode.get(epId).push(ev);
  }
  for (const group of byEpisode.values()) {
    group.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    for (let i = 0; i < group.length - 1; i++) {
      edgeRows.push({ from: group[i].id, to: group[i + 1].id, kind: 'before' });
    }
  }

  // Cross-batch `before` edge: if the previous batch for this source ended in
  // an episode that this batch's first event also belongs to, chain them.
  // Uses per-source cursor `runtime:biographer.value.last_event_by_source`.
  try {
    const prevCursor = runtime?.last_event_by_source?.[source];
    if (prevCursor?.event_id && prevCursor?.episode_id) {
      // Find the earliest event in this batch whose episode matches the cursor.
      let chained = null;
      const sortedValid = [...validEvents].sort(
        (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
      );
      for (const ev of sortedValid) {
        if (String(episodeIdForEvent.get(String(ev.id))) === String(prevCursor.episode_id)) {
          chained = ev;
          break;
        }
      }
      if (chained) {
        const { RecordId } = await import('surrealdb');
        const fromId =
          typeof prevCursor.event_id === 'string' && prevCursor.event_id.includes(':')
            ? new RecordId('events', prevCursor.event_id.split(':')[1])
            : new RecordId('events', prevCursor.event_id);
        edgeRows.push({ from: fromId, to: chained.id, kind: 'before' });
      }
    }
  } catch {
    /* fail-soft: cross-batch chaining is best-effort */
  }

  // 9. Write edges (one batched relateAll call; chunks at 50 internally).
  if (edgeRows.length > 0) {
    await withTxRetry(() => store.relateAll(db, edgeRows));
  }

  // 10. Per-episode-group gated mark step (spec §3, §7 invariant).
  //     For each distinct episode in the batch, one UPDATE with
  //     WHERE id IN $idsForEpisode AND biographed_at IS NONE.
  const validIdStrs = validEvents.map((ev) => String(ev.id));
  const idsByEpisode = new Map(); // episodeId -> RecordId[]
  for (const ev of validEvents) {
    const epId = episodeIdForEvent.get(String(ev.id));
    if (!idsByEpisode.has(epId)) idsByEpisode.set(epId, []);
    idsByEpisode.get(epId).push(ev.id);
  }
  const markedSet = new Set();
  await withTxRetry(async () => {
    for (const [epId, idsForEpisode] of idsByEpisode) {
      const [rows] = await db
        .query(
          surql`
          UPDATE events
            SET biographed_at = time::now(), episode_id = ${epId}
            WHERE id IN ${idsForEpisode} AND biographed_at IS NONE
        `,
        )
        .collect();
      for (const r of rows) markedSet.add(String(r.id));
    }
  });
  const racedCount = validIdStrs.length - markedSet.size;
  const batchKey = opts.__queueKey ?? `${source}:${[...validIdStrs].sort().join(',')}`;
  if (racedCount > 0) {
    console.warn(
      `biographer race detected on ${racedCount}/${validIdStrs.length} events in batch ${batchKey}`,
    );
  }
  for (const ev of validEvents) {
    perEvent.set(String(ev.id), {
      processed: true,
      episodeId: episodeIdForEvent.get(String(ev.id)),
      entitiesCount: keyToId.size,
    });
  }

  // 11. Evidence signals (Theme 2a) — AFTER the gated mark UPDATE succeeds.
  //     Running addEvidence BEFORE the mark would double-count the ledger on
  //     retry. Limit to events whose mark actually landed (markedSet).
  if (evidenceJobs.length > 0) {
    try {
      const { addEvidence, readEvidenceConfig } = await import('../memory/evidence.js');
      const { RecordId } = await import('surrealdb');
      const evCfg = await readEvidenceConfig(db);
      for (const { ev, signals } of evidenceJobs) {
        if (!markedSet.has(String(ev.id))) continue;
        for (const sig of signals) {
          try {
            const idStr = String(sig.memo_id);
            const key = idStr.startsWith('memos:') ? idStr.slice('memos:'.length) : idStr;
            await addEvidence(db, {
              memo_id: new RecordId('memos', key),
              polarity: sig.polarity,
              reason: 'biographer',
              weight: evCfg.biographer_weight ?? 0.5,
              source_event: ev.id,
            });
          } catch (e) {
            console.warn(`[biographer evidence_signal] ${sig?.memo_id}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[biographer evidence_signals] ${e.message}`);
    }
  }

  // 12. Runtime row: telemetry + last_run housekeeping.
  const inputTokens = Number(response?.usage?.input_tokens ?? 0);
  const outputTokens = Number(response?.usage?.output_tokens ?? 0);
  await _recordBatchTelemetry(db, {
    batches_total_delta: 1,
    batch_size: validEvents.length,
    events_biographed_via_batch_delta: markedSet.size,
    batch_input_tokens_delta: inputTokens,
    batch_output_tokens_delta: outputTokens,
    last_batch_input_tokens: inputTokens,
    last_batch_output_tokens: outputTokens,
  });
  // Structured per-batch row (additive to the runtime counters).
  await _writeBiographerTelemetry(db, {
    source,
    batch_size: validEvents.length,
    via: 'batch',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_ms: Date.now() - batchStartedAt,
  });

  // Housekeeping: last_processed + last_run_at + per-source cross-batch
  // cursor. The cursor feeds the next batch's cross-batch `before` edge so
  // we can chain the last event of batch K to the first event of batch K+1
  // when they share an episode.
  const sortedValidEvents = [...validEvents].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );
  const lastEvent = sortedValidEvents[sortedValidEvents.length - 1];
  const lastEventId = String(lastEvent.id?.id ?? lastEvent.id);
  const lastEpisodeId = String(episodeIdForEvent.get(String(lastEvent.id)));
  await withTxRetry(async () => {
    await db
      .query(
        surql`
        UPSERT type::record('runtime', 'biographer')
          SET value.last_processed_event_id = ${lastEventId},
              value.last_run_at = time::now(),
              value.last_event_by_source[${source}] = ${{
                event_id: lastEventId,
                episode_id: lastEpisodeId,
              }}
      `,
      )
      .collect();
  });

  return { perEvent };
}

async function _fallbackPerEvent(db, embedder, host, eventIds, perEvent, opts, _batchError) {
  // Single-event fallback. Spec §8: never worse than today's baseline.
  const fallbackStartedAt = Date.now();
  let successCount = 0;
  for (const id of eventIds) {
    try {
      const r = await _processOne(db, embedder, host, id, opts);
      perEvent.set(String(id), r);
      if (r?.processed) successCount++;
    } catch (e) {
      perEvent.set(String(id), { failed: true, error: e.message });
    }
  }
  await _recordBatchTelemetry(db, {
    batches_total_delta: 1,
    batches_fallback_delta: 1,
    events_biographed_via_fallback_delta: successCount,
  });
  // Structured per-batch row for the fallback path. The fallback reason
  // was already written to runtime via _recordBatchFallback; carry it here
  // best-effort by reading it back.
  let fallbackReason = null;
  try {
    const [rt] = await db
      .query("SELECT * FROM type::record('runtime', 'biographer') LIMIT 1")
      .collect();
    fallbackReason = rt[0]?.value?.last_fallback_reason ?? null;
  } catch {
    /* fail-soft */
  }
  await _writeBiographerTelemetry(db, {
    source: '__fallback__', // multi-source possible in fallback path
    batch_size: eventIds.length,
    via: 'fallback',
    input_tokens: 0,
    output_tokens: 0,
    duration_ms: Date.now() - fallbackStartedAt,
    fallback_reason: fallbackReason,
  });
  return { perEvent };
}

async function _recordBatchFallback(db, reason) {
  await withTxRetry(async () => {
    await db
      .query(surql`
        UPSERT type::record('runtime', 'biographer')
        SET value.last_fallback_reason = ${reason},
            value.last_fallback_at     = time::now()
      `)
      .collect();
  });
}

async function _recordBatchTelemetry(
  db,
  {
    batches_total_delta = 0,
    batches_fallback_delta = 0,
    events_biographed_via_batch_delta = 0,
    events_biographed_via_fallback_delta = 0,
    batch_input_tokens_delta = 0,
    batch_output_tokens_delta = 0,
    last_batch_input_tokens,
    last_batch_output_tokens,
    batch_size,
  },
) {
  await withTxRetry(async () => {
    await db
      .query(surql`
        UPSERT type::record('runtime', 'biographer')
        SET value.batches_total                  = (value.batches_total                  ?? 0) + ${batches_total_delta},
            value.batches_fallback               = (value.batches_fallback               ?? 0) + ${batches_fallback_delta},
            value.events_biographed_via_batch    = (value.events_biographed_via_batch    ?? 0) + ${events_biographed_via_batch_delta},
            value.events_biographed_via_fallback = (value.events_biographed_via_fallback ?? 0) + ${events_biographed_via_fallback_delta},
            value.batch_input_tokens_total       = (value.batch_input_tokens_total       ?? 0) + ${batch_input_tokens_delta},
            value.batch_output_tokens_total      = (value.batch_output_tokens_total      ?? 0) + ${batch_output_tokens_delta},
            value.last_batch_size                = ${batch_size ?? null},
            value.last_batch_input_tokens        = ${last_batch_input_tokens ?? null},
            value.last_batch_output_tokens       = ${last_batch_output_tokens ?? null}
      `)
      .collect();
  });
}

// Append a structured row to biographer_telemetry (post-alpha.17 follow-up).
// Additive to the runtime counters above — both are written. Fail-soft so
// a missing table (legacy installs running before 0022) never blocks a batch.
async function _writeBiographerTelemetry(db, fields) {
  try {
    await db
      .query(
        surql`CREATE biographer_telemetry CONTENT ${{
          source: String(fields.source ?? '__unknown__'),
          batch_size: Number(fields.batch_size ?? 0),
          via: String(fields.via ?? 'batch'),
          input_tokens: Number(fields.input_tokens ?? 0),
          output_tokens: Number(fields.output_tokens ?? 0),
          duration_ms: Number(fields.duration_ms ?? 0),
          ...(fields.fallback_reason ? { fallback_reason: String(fields.fallback_reason) } : {}),
        }}`,
      )
      .collect();
  } catch {
    /* fail-soft */
  }
}

async function _processOne(db, embedder, host, eventId, opts = {}) {
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
    output = parseLLMJSON(response.content);
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

  // Theme 2a: process optional evidence_signals from biographer LLM output.
  // Each signal asserts that the new event corroborates / refutes an existing
  // memo. We emit a ledger row with weight from config (default 0.5).
  if (Array.isArray(output.evidence_signals) && output.evidence_signals.length > 0) {
    try {
      const { addEvidence, readEvidenceConfig } = await import('../memory/evidence.js');
      const { RecordId } = await import('surrealdb');
      const evCfg = await readEvidenceConfig(db);
      for (const sig of output.evidence_signals) {
        try {
          const idStr = String(sig.memo_id);
          const key = idStr.startsWith('memos:') ? idStr.slice('memos:'.length) : idStr;
          await addEvidence(db, {
            memo_id: new RecordId('memos', key),
            polarity: sig.polarity,
            reason: 'biographer',
            weight: evCfg.biographer_weight ?? 0.5,
            source_event: eventId,
          });
        } catch (e) {
          console.warn(`[biographer evidence_signal] ${sig?.memo_id}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`[biographer evidence_signals] ${e.message}`);
    }
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
