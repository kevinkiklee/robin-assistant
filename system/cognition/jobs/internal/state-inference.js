// state-inference.js — heartbeat-paced internal job that produces
// kind='state_inference' memos per active source.
//
// Cognition D1 spec §1, §5. This file contains the per-source pipeline
// (composeForSource), the active-source loop entry point
// (evaluateStateInference), and two pure helpers (computeSignalHash,
// detectChange) that are unit-tested in isolation.

import { BoundQuery, surql } from 'surrealdb';
import { sha256 } from '../../../data/embed/hash.js';
import { getAttention } from '../../memory/attention.js';
import { addEvidence } from '../../memory/evidence.js';
import { isOutboundBlocked } from '../../memory/scope-registry.js';
import { latestForSource, noteStateInference } from '../../memory/state_inference.js';
import * as store from '../../memory/store.js';

/**
 * Stable hash over the inputs that define "what is the user working on?":
 *   - sorted entity record-ref strings
 *   - String(arc_id ?? null)
 *   - String(last_event_id ?? null)
 *
 * Sorting makes the hash insensitive to attention-lens ordering jitter.
 *
 * @param {{ entities: (string|object)[], arc_id?: string|null, last_event_id?: string|null }} inputs
 * @returns {string} hex SHA-256
 */
export function computeSignalHash({ entities = [], arc_id = null, last_event_id = null } = {}) {
  const ents = entities
    .map((e) => (e == null ? '' : String(e)))
    .filter((s) => s.length > 0)
    .sort();
  const payload = JSON.stringify({
    entities: ents,
    arc_id: arc_id == null ? null : String(arc_id),
    last_event_id: last_event_id == null ? null : String(last_event_id),
  });
  return sha256(payload);
}

/**
 * Decide whether the current snapshot differs materially from the prior
 * inference. Returns { materially_changed, signal_hash, reason } where
 * reason ∈ { 'no_prior', 'hash_differs', 'refresh_window', 'unchanged' }.
 *
 * Spec §1.3 step 5.
 *
 * @param {{
 *   prior: { meta?: { signal_hash?: string, last_active_at?: string|Date } } | null,
 *   current: { entities: (string|object)[], arc_id?: string|null, last_event_id?: string|null },
 *   now?: Date,
 *   refreshAfterMinutes?: number,
 * }} args
 */
export function detectChange({ prior, current, now = new Date(), refreshAfterMinutes = 30 }) {
  const signal_hash = computeSignalHash(current);
  if (!prior) {
    return { materially_changed: true, signal_hash, reason: 'no_prior' };
  }
  const priorHash = prior?.meta?.signal_hash ?? '';
  if (priorHash && priorHash !== signal_hash) {
    return { materially_changed: true, signal_hash, reason: 'hash_differs' };
  }
  const priorActive = prior?.meta?.last_active_at;
  if (priorActive) {
    const t = priorActive instanceof Date ? priorActive : new Date(priorActive);
    if (Number.isFinite(t.getTime())) {
      const ageMs = now.getTime() - t.getTime();
      if (ageMs > refreshAfterMinutes * 60_000) {
        return { materially_changed: true, signal_hash, reason: 'refresh_window' };
      }
    }
  }
  return { materially_changed: false, signal_hash, reason: 'unchanged' };
}

export const STATE_INFERENCE_SYSTEM = `You produce a one-sentence statement of what the user is currently working on, based on recent activity. Stay grounded in the evidence; do not speculate beyond what the inputs support. Output strict JSON.`;

export function buildPrompt({ arc, entities, events, prior }) {
  const entityLines = (entities ?? [])
    .slice(0, 10)
    .map((e) => `${e.type ?? 'unknown'}/${e.name ?? '?'}`)
    .join(', ');
  const eventLines = (events ?? [])
    .slice(0, 5)
    .map((e) => `- [${e.ts}] ${String(e.content ?? '').slice(0, 120)}`)
    .join('\n');
  return [
    `Active arc: ${arc?.summary ?? 'none'}`,
    `Recent entities: ${entityLines || 'none'}`,
    `Recent events (latest first):`,
    eventLines || '- (none)',
    `Prior inference (for context, may be stale): ${prior?.content ?? 'none'}`,
    ``,
    `Respond JSON only:`,
    `{ "focus_statement": string,`,
    `  "confidence": number,`,
    `  "evidence_snippet": string,`,
    `  "ambiguous": boolean,`,
    `  "drop": boolean }`,
  ].join('\n');
}

export function clampConfidence(c, ambiguous) {
  let v = typeof c === 'number' && Number.isFinite(c) ? c : 0.5;
  if (ambiguous) v = v * 0.5;
  if (v < 0.05) v = 0.05;
  if (v > 0.95) v = 0.95;
  return v;
}

export function validateLLMOutput(o) {
  if (!o || typeof o !== 'object') return { ok: false, error: 'not_object' };
  if (typeof o.focus_statement !== 'string') return { ok: false, error: 'missing_focus_statement' };
  if (typeof o.confidence !== 'number') return { ok: false, error: 'missing_confidence' };
  if (typeof o.ambiguous !== 'boolean') return { ok: false, error: 'missing_ambiguous' };
  if (typeof o.drop !== 'boolean') return { ok: false, error: 'missing_drop' };
  return { ok: true };
}

/**
 * Read all inputs needed for one source's inference: attention lens + top
 * active arc that overlaps the attention entity set + up to 5 most-recent
 * biographed events whose mentions intersect that entity set.
 *
 * Spec §1.3 steps 2–4.
 *
 * Also computes a `privateScopeDetected` flag (§6.1): true if any candidate
 * entity, arc, or event has `scope` in the outbound-blocked set.
 */
export async function readInputsForSource(db, embedder, { source, windowMinutes }) {
  const attention = await getAttention(db, { source, windowMinutes });
  const entityIds = (attention.entities ?? []).map((e) => e.id);
  const entityIdStrs = entityIds.map((id) => String(id));

  let arc = null;
  if (entityIds.length > 0) {
    let arcRows = [];
    try {
      const [rows] = await db
        .query(
          new BoundQuery(
            `SELECT id, name, summary, entity_ids, scope, last_activity_at FROM arcs
             WHERE status = 'active'
               AND last_activity_at >= time::now() - 24h
               AND entity_ids ANYINSIDE $eids
             ORDER BY last_activity_at DESC
             LIMIT 10`,
            { eids: entityIds },
          ),
        )
        .collect();
      arcRows = rows ?? [];
    } catch {
      arcRows = [];
    }
    let best = null;
    let bestOverlap = -1;
    for (const a of arcRows) {
      const arcEntities = new Set((a.entity_ids ?? []).map((x) => String(x)));
      let overlap = 0;
      for (const s of entityIdStrs) if (arcEntities.has(s)) overlap++;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = a;
      }
    }
    arc = best;
  }

  const recentEventIds = (attention.recent_events ?? []).map((e) => e.id);
  let events = [];
  if (recentEventIds.length > 0 && entityIds.length > 0) {
    try {
      // Mentions edges live on the unified `edges` table (TYPE RELATION) with
      // `kind = 'mentions'`. Filter events whose id appears as `in` on a
      // mentions edge whose `out` is one of our attention entities.
      const [rows] = await db
        .query(
          new BoundQuery(
            `SELECT id, content, ts, scope FROM events
             WHERE id IN $eids
               AND biographed_at IS NOT NONE
               AND id IN (SELECT VALUE in FROM edges WHERE kind = 'mentions' AND out IN $entIds)
             ORDER BY ts DESC
             LIMIT 5`,
            { eids: recentEventIds, entIds: entityIds },
          ),
        )
        .collect();
      events = rows ?? [];
    } catch {
      events = [];
    }
  }

  // Scope inheritance check (spec §6.1). Hydrate scope for candidate
  // entities + chosen events + arc. We do not (v1) walk transitive
  // derived_from chains — see spec §6.3.
  let privateScopeDetected = false;
  try {
    if (entityIds.length > 0) {
      const [entRows] = await db
        .query(
          new BoundQuery('SELECT id, scope FROM entities WHERE id IN $ids', { ids: entityIds }),
        )
        .collect();
      for (const r of entRows ?? []) {
        if (r?.scope && isOutboundBlocked(r.scope)) {
          privateScopeDetected = true;
          break;
        }
      }
    }
    if (!privateScopeDetected) {
      for (const ev of events) {
        if (ev?.scope && isOutboundBlocked(ev.scope)) {
          privateScopeDetected = true;
          break;
        }
      }
    }
    if (!privateScopeDetected && arc?.scope && isOutboundBlocked(arc.scope)) {
      privateScopeDetected = true;
    }
  } catch {
    // Scope lookup failures fail-open to private to avoid leaking; tests
    // assert against the "no rows" path, so this branch only fires on
    // engine error which is rare and conservative.
    privateScopeDetected = true;
  }

  return { attention, arc, events, privateScopeDetected };
}

const MIN_EVENTS = 2;
const CONTENT_MAX = 240;
const EVIDENCE_SNIPPET_MAX = 120;

async function recordTelemetry(db, row) {
  try {
    await db.query(surql`CREATE state_inference_telemetry CONTENT ${row}`).collect();
  } catch {
    /* telemetry is advisory */
  }
}

async function priorHasCalibrationRow(db, prior) {
  // Per spec §5.1 — skip calibration emission only when an evidence_ledger
  // row exists for this prior with `ts > prior.derived_at` (i.e., a
  // post-derived calibration). Rows older than the prior would belong to a
  // prior generation and must not block the new emission.
  try {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT count() AS n FROM evidence_ledger
           WHERE memo_id = $id
             AND reason IN ['state_inference_held','state_inference_pivoted']
             AND ts > $prior_derived_at
           GROUP ALL`,
          { id: prior?.id, prior_derived_at: prior?.derived_at },
        ),
      )
      .collect();
    return (rows?.[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

function classifyPriorVsCurrent(prior, current) {
  const priorEnts = new Set((prior?.meta?.entities ?? []).map((s) => String(s)));
  const curEnts = new Set((current.entities ?? []).map((s) => String(s)));
  let inter = 0;
  for (const s of priorEnts) if (curEnts.has(s)) inter++;
  const denom = Math.max(priorEnts.size, curEnts.size) || 1;
  const overlap = inter / denom;
  const priorArc = prior?.meta?.arc_id ?? null;
  const curArc = current.arc_id ?? null;
  const arcMatches = String(priorArc ?? '') === String(curArc ?? '');
  if (overlap >= 0.5 && arcMatches) return 'corroborated';
  if (!arcMatches && overlap < 0.25) return 'refuted';
  return 'ambiguous';
}

/**
 * Run the per-source pipeline (spec §1.3 steps 1–10).
 *
 * Returns one of:
 *   { outcome: 'wrote', id, signal_hash, latency_ms, tokens_in, tokens_out }
 *   { outcome: 'skipped_unchanged', signal_hash }
 *   { outcome: 'skipped_disabled' }
 *   { outcome: 'dropped_thin', reason }
 *   { outcome: 'error', reason }
 */
export async function composeForSource({ db, embedder, host, source, cfg, now = new Date() }) {
  if (cfg.enabled === false) {
    await recordTelemetry(db, { source, outcome: 'skipped_disabled' });
    return { outcome: 'skipped_disabled' };
  }

  const shadow = cfg.enabled === 'shadow';

  let prior;
  try {
    prior = await latestForSource(db, source);
  } catch (e) {
    await recordTelemetry(db, { source, outcome: 'error', reason: `latestForSource: ${e.message}` });
    return { outcome: 'error', reason: e.message };
  }

  let inputs;
  try {
    inputs = await readInputsForSource(db, embedder, {
      source,
      windowMinutes: cfg.attention_window_min,
    });
  } catch (e) {
    await recordTelemetry(db, { source, outcome: 'error', reason: `readInputs: ${e.message}` });
    return { outcome: 'error', reason: e.message };
  }

  const { attention, arc, events, privateScopeDetected } = inputs;
  const entityIds = (attention.entities ?? []).map((e) => e.id);

  // Thin-evidence guard. Empty attention OR too few events → dropped_thin.
  const minEv = Number.isInteger(cfg.min_events_for_inference)
    ? cfg.min_events_for_inference
    : MIN_EVENTS;
  if (entityIds.length === 0 || events.length < Math.max(1, minEv - 1)) {
    await recordTelemetry(db, { source, outcome: 'dropped_thin', reason: 'empty_attention' });
    return { outcome: 'dropped_thin', reason: 'empty_attention' };
  }

  const current = {
    entities: entityIds.map((id) => String(id)),
    arc_id: arc?.id != null ? String(arc.id) : null,
    last_event_id: events[0]?.id != null ? String(events[0].id) : null,
  };

  const change = detectChange({
    prior,
    current,
    now,
    refreshAfterMinutes: cfg.refresh_after_minutes ?? 30,
  });
  if (!change.materially_changed) {
    await recordTelemetry(db, {
      source,
      outcome: 'skipped_unchanged',
      signal_hash: change.signal_hash,
    });
    return { outcome: 'skipped_unchanged', signal_hash: change.signal_hash };
  }

  // Calibration sub-step (spec §5.1) — runs before the LLM call; classified
  // against the current snapshot regardless of whether the LLM later drops.
  if (prior && !shadow) {
    const cls = classifyPriorVsCurrent(prior, current);
    if (cls !== 'ambiguous') {
      const dedup = await priorHasCalibrationRow(db, prior);
      if (!dedup) {
        try {
          await addEvidence(db, {
            memo_id: prior.id,
            polarity: cls === 'corroborated' ? 'corroborates' : 'refutes',
            reason: cls === 'corroborated' ? 'state_inference_held' : 'state_inference_pivoted',
            weight:
              cls === 'corroborated'
                ? (cfg.corroborate_weight ?? 1.0)
                : (cfg.pivot_weight ?? 1.0),
          });
        } catch {
          /* fail-soft */
        }
      }
    }
  }

  // LLM call (spec §1.3 step 7).
  const userPrompt = buildPrompt({
    arc,
    entities: attention.entities ?? [],
    events,
    prior,
  });
  const startedAt = Date.now();
  let llmResult;
  try {
    const r = await host.invokeLLM([{ role: 'user', content: userPrompt }], {
      tier: 'fast',
      json: true,
      system: [
        {
          role: 'system',
          content: STATE_INFERENCE_SYSTEM,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    llmResult = JSON.parse(r.content);
    // `host.invokeLLM` returns `{ content, usage: { input_tokens,
    // output_tokens, cache_read_tokens } }` per
    // `system/runtime/hosts/claude-code.js`. There is no top-level
    // `r.tokens_in` / `r.tokens_out` — those keys are always undefined.
    llmResult._tokens_in = r.usage?.input_tokens ?? null;
    llmResult._tokens_out = r.usage?.output_tokens ?? null;
  } catch (e) {
    await recordTelemetry(db, {
      source,
      outcome: 'error',
      reason: `llm: ${e.message}`,
      signal_hash: change.signal_hash,
      latency_ms: Date.now() - startedAt,
    });
    return { outcome: 'error', reason: e.message };
  }

  const validation = validateLLMOutput(llmResult);
  if (!validation.ok) {
    await recordTelemetry(db, {
      source,
      outcome: 'error',
      reason: `validate: ${validation.error}`,
      signal_hash: change.signal_hash,
      latency_ms: Date.now() - startedAt,
    });
    return { outcome: 'error', reason: validation.error };
  }

  if (llmResult.drop === true) {
    await recordTelemetry(db, {
      source,
      outcome: 'dropped_thin',
      signal_hash: change.signal_hash,
      tokens_in: llmResult._tokens_in,
      tokens_out: llmResult._tokens_out,
      latency_ms: Date.now() - startedAt,
      reason: 'llm_drop',
    });
    return { outcome: 'dropped_thin', reason: 'llm_drop' };
  }

  if (shadow) {
    await recordTelemetry(db, {
      source,
      outcome: 'wrote',
      signal_hash: change.signal_hash,
      tokens_in: llmResult._tokens_in,
      tokens_out: llmResult._tokens_out,
      latency_ms: Date.now() - startedAt,
      reason: 'shadow',
    });
    return {
      outcome: 'wrote',
      shadow: true,
      signal_hash: change.signal_hash,
    };
  }

  // Write the memo (spec §1.3 step 8).
  const content = String(llmResult.focus_statement ?? '').slice(0, CONTENT_MAX);
  const confidence = clampConfidence(llmResult.confidence, llmResult.ambiguous === true);
  const evidenceSnippet = String(llmResult.evidence_snippet ?? '').slice(0, EVIDENCE_SNIPPET_MAX);

  const fromSignal = [];
  if (attention.entities?.length) fromSignal.push('attention');
  if (arc) fromSignal.push('arcs');
  if (events.length > 0) fromSignal.push('biographer');

  const scope = privateScopeDetected ? 'private' : 'global';

  let created;
  try {
    created = await noteStateInference(db, embedder, {
      source,
      content,
      confidence,
      entities: entityIds,
      arc_id: arc?.id ?? null,
      last_event_id: events[0]?.id ?? null,
      // Wrap as `{id}` so store.note's `l.id ?? l` extraction preserves the
       // record-ref (raw RecordId objects expose `.id` as just the bare key
       // string, which would strip the table prefix).
       lineage: events.slice(0, 5).map((e) => ({ id: e.id })),
      evidence_snippet: evidenceSnippet,
      last_active_at: new Date(),
      from_signal: fromSignal,
      signal_hash: change.signal_hash,
      scope,
    });
  } catch (e) {
    await recordTelemetry(db, {
      source,
      outcome: 'error',
      reason: `write: ${e.message}`,
      signal_hash: change.signal_hash,
      latency_ms: Date.now() - startedAt,
    });
    return { outcome: 'error', reason: e.message };
  }

  // Supersede the prior (spec §1.3 step 9).
  if (prior) {
    try {
      await store.supersede(db, prior.id, created.id);
    } catch (e) {
      // Memo was written; supersede failure is non-fatal for this tick. Log.
      console.warn(`[state-inference] supersede failed: ${e.message}`);
    }
  }

  await recordTelemetry(db, {
    source,
    outcome: 'wrote',
    signal_hash: change.signal_hash,
    tokens_in: llmResult._tokens_in,
    tokens_out: llmResult._tokens_out,
    latency_ms: Date.now() - startedAt,
  });

  return {
    outcome: 'wrote',
    id: created.id,
    signal_hash: change.signal_hash,
    tokens_in: llmResult._tokens_in,
    tokens_out: llmResult._tokens_out,
    latency_ms: Date.now() - startedAt,
  };
}

const DEFAULTS = {
  enabled: false,
  tick_ms: 300000,
  attention_window_min: 90,
  refresh_after_minutes: 30,
  min_events_for_inference: 2,
  max_sources_per_tick: 4,
  min_confidence_to_surface: 0.5,
  stale_after_minutes: 120,
  pivot_weight: 1.0,
  corroborate_weight: 1.0,
};

let _cfgCache = { value: null, expiresAt: 0 };
const CFG_TTL_MS = 5_000;

export async function readStateInferenceConfig(db, { now = Date.now() } = {}) {
  if (_cfgCache.value && _cfgCache.expiresAt > now) return _cfgCache.value;
  let cfg = DEFAULTS;
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`state_inference.config`')
      .collect();
    if (rows?.[0]) cfg = { ...DEFAULTS, ...rows[0] };
  } catch {
    /* defaults */
  }
  _cfgCache = { value: cfg, expiresAt: now + CFG_TTL_MS };
  return cfg;
}

// Exposed for tests.
export function _clearStateInferenceConfigCache() {
  _cfgCache = { value: null, expiresAt: 0 };
}

async function listActiveSources(db) {
  // Active source = any episode with ended_at IS NONE AND started_at >= now-24h.
  const [rows] = await db
    .query(
      surql`SELECT VALUE source FROM episodes
            WHERE ended_at IS NONE
              AND started_at >= time::now() - 24h
            GROUP BY source`,
    )
    .collect();
  const seen = new Set();
  const out = [];
  for (const s of rows ?? []) {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Heartbeat-paced entry point (spec §1.1). Reads config, lists active
 * sources, runs composeForSource for up to cfg.max_sources_per_tick.
 *
 * @returns {Promise<{
 *   outcome: 'skipped_disabled' | 'no_active_sources' | 'ran',
 *   sources_evaluated?: number,
 *   per_source?: Array<{ source: string, outcome: string }>
 * }>}
 */
export async function evaluateStateInference({ db, host, embedder, now = new Date() } = {}) {
  // Cache invalidation is per-tick to pick up flag flips without restart.
  _clearStateInferenceConfigCache();
  const cfg = await readStateInferenceConfig(db);
  if (cfg.enabled === false) {
    return { outcome: 'skipped_disabled' };
  }
  const sources = await listActiveSources(db);
  if (sources.length === 0) {
    return { outcome: 'no_active_sources' };
  }
  const cap = Math.max(1, cfg.max_sources_per_tick ?? DEFAULTS.max_sources_per_tick);
  const selected = sources.slice(0, cap);
  const per_source = [];
  for (const source of selected) {
    try {
      const r = await composeForSource({ db, embedder, host, source, cfg, now });
      per_source.push({ source, outcome: r.outcome });
    } catch (e) {
      per_source.push({ source, outcome: 'error' });
      console.warn(`[state-inference ${source}] ${e.message}`);
    }
  }
  return { outcome: 'ran', sources_evaluated: per_source.length, per_source };
}
