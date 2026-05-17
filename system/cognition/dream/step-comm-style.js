// system/cognition/dream/step-comm-style.js — Dream step: synthesize comm-style preferences.
//
// Two-layer synthesis:
//
// 1. DEFAULT (unchanged) — delegates to synthesizeCommStyle() in jobs/comm-style.js.
//    Runs over the full correction pool, writes persona:singleton.comm_style (flat shape,
//    backward-compatible with all existing consumers: agents-md, get-comm-style tool, CLI).
//
// 2. PER-CONTEXT (new, spec §4d) — partitions correction events by context
//    (discord / terminal / web), synthesizes each context with ≥10 evidence events,
//    and writes the result to persona:singleton.comm_style_contexts.
//    Under-evidenced contexts remain null; inject reads fall back to comm_style (default).
//
// Convergence: per-context, 2 consecutive synthesizes with matching content_hash →
// volatile = false. A content_hash mismatch → volatile = true.
//
// Snapshots (spec §4d gap): after each successful synthesis (default OR per-context),
// a comm_style_snapshot memo is written. persona:singleton.comm_style.last_snapshot_id
// and comm_style_contexts.<ctx>.last_snapshot_id point to the active rows so playbooks
// can cite via related_comm_style_snapshot. Idempotent: skipped when the input/output
// hash matches the latest snapshot for that context.
//
// FAIL-SOFT: errors here MUST NOT abort the Dream run.

import { createHash } from 'node:crypto';
import { BoundQuery, surql } from 'surrealdb';
import { parseLLMJSON } from '../biographer/output.js';
import { synthesizeCommStyle, validateCommStyleShape } from '../jobs/comm-style.js';
import {
  CONTEXTS,
  partitionByContext,
  resolveSessionContext,
} from './comm-style-context-router.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECENCY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — mirrors jobs/comm-style.js
const SIGNAL_CAP = 100;
const PER_CONTEXT_MIN_SIGNALS = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable hash over a sorted list of (id:content) pairs. */
function hashSignals(events) {
  const parts = events
    .map((e) => `${String(e.id)}:${String(e.content ?? '')}`)
    .sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/** Build the LLM prompt for a set of correction events. */
function buildContextPrompt(events, context) {
  const numbered = events.map((c, i) => `${i + 1}. ${c.content}`).join('\n');
  return `You are inferring a user's communication-style preferences from their recent corrections to an AI assistant, specifically for the "${context}" context (${context === 'discord' ? 'Discord bot' : context === 'web' ? 'web UI (askrobin.io)' : 'terminal / Claude Code / Cursor / Gemini CLI'}).

Recent corrections for this context (last 30 days, newest first):
${numbered}

Respond with strict JSON only:

{
  "tone": "terse" | "balanced" | "verbose",
  "formality": "casual" | "balanced" | "formal",
  "emoji_ok": boolean,
  "direct_feedback_ok": boolean,
  "code_comment_density": "minimal" | "moderate" | "verbose",
  "summary_style": "bullets" | "prose" | "mixed",
  "confidence": <float 0..1, how confident are you?>,
  "evidence_indices": <[int], 1-indexed indices of corrections that most informed this>
}

If a field has no signal, pick "balanced" (or false for booleans). No commentary, no markdown fences.`;
}

/** Read the current comm_style_contexts from persona:singleton. */
async function getContexts(db) {
  const [rows] = await db
    .query(surql`SELECT comm_style_contexts FROM persona:singleton`)
    .collect();
  return rows?.[0]?.comm_style_contexts ?? null;
}

/** Write the full per-context object back to persona:singleton. */
async function setContexts(db, contexts) {
  await db
    .query(surql`UPSERT persona:singleton MERGE ${{ comm_style_contexts: contexts }}`)
    .collect();
}

/**
 * Fetch the latest comm_style_snapshot memo for a given context.
 * Returns the row (id + meta) or null.
 */
async function getLatestSnapshot(db, context) {
  // SurrealDB v3: ORDER BY fields must appear in the SELECT list.
  const [rows] = await db
    .query(
      new BoundQuery(
        `SELECT id, meta, meta.last_synthesized_at AS last_synthesized_at FROM memos
         WHERE kind = 'comm_style_snapshot' AND meta.context = $ctx
         ORDER BY last_synthesized_at DESC LIMIT 1`,
        { ctx: context },
      ),
    )
    .collect();
  return rows?.[0] ?? null;
}

/**
 * Write a comm_style_snapshot memo and return its id string.
 * Idempotent: if the latest snapshot for the context already has a matching
 * content_hash, skip and return the existing id.
 *
 * @param {object} opts
 * @param {object} db
 * @param {'default'|'discord'|'terminal'|'web'} opts.context
 * @param {object} opts.synthesizedFields - the validated comm-style shape
 * @param {string} opts.contentHash - sha256 of the synthesized shape
 * @param {boolean} opts.volatile
 * @param {number} opts.evidenceCount
 * @returns {Promise<string|null>} snapshot memo id string, or null on error
 */
async function writeCommStyleSnapshot(db, { context, synthesizedFields, contentHash, volatile, evidenceCount }) {
  // Idempotency: skip if the latest snapshot for this context has the same content_hash.
  const latest = await getLatestSnapshot(db, context);
  if (latest?.meta?.content_hash === contentHash) {
    return String(latest.id);
  }

  const now = new Date().toISOString();
  const summary = `comm_style/${context}: tone=${synthesizedFields.tone ?? '?'} formality=${synthesizedFields.formality ?? '?'} confidence=${synthesizedFields.confidence ?? 0}`;
  const fields = {
    kind: 'comm_style_snapshot',
    content: summary,
    derived_by: 'comm-style-synthesis',
    scope: 'global',
    tags: [],
    meta: {
      context,
      content_hash: contentHash,
      volatile,
      evidence_count: evidenceCount,
      last_synthesized_at: now,
      synthesized_fields: synthesizedFields,
    },
  };

  try {
    const [rows] = await db
      .query(new BoundQuery('CREATE memos CONTENT $fields', { fields }))
      .collect();
    const row = Array.isArray(rows) ? rows[0] : rows;
    return row?.id ? String(row.id) : null;
  } catch (e) {
    console.warn(`[dream] step-comm-style: snapshot write failed (${context}): ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-context synthesis for a single context
// ---------------------------------------------------------------------------

/**
 * Synthesize a single context. Returns an updated context record or null on
 * failure (caller logs and continues).
 *
 * @param {object} opts
 * @param {Array<object>} opts.events - evidence events for this context
 * @param {string} opts.context - 'discord' | 'terminal' | 'web'
 * @param {object|null} opts.prior - existing context record (for convergence)
 * @param {object} opts.host - LLM host
 * @returns {Promise<{record: object|null, tokens_in: number, tokens_out: number, cached: boolean}>}
 */
async function synthesizeOneContext({ events, context, prior, host }) {
  if (events.length < PER_CONTEXT_MIN_SIGNALS) {
    return { record: null, tokens_in: 0, tokens_out: 0, cached: false };
  }

  const input_hash = hashSignals(events);

  // Short-circuit: same evidence as last time → update convergence only.
  if (prior?.input_hash === input_hash) {
    const consec = (prior.consecutive_matches ?? 0) + 1;
    const volatile = consec < 2;
    return {
      record: { ...prior, consecutive_matches: consec, volatile },
      tokens_in: 0,
      tokens_out: 0,
      cached: true,
    };
  }

  if (!host?.invokeLLM) {
    return { record: null, tokens_in: 0, tokens_out: 0, cached: false };
  }

  let parsed;
  let tokens_in = 0;
  let tokens_out = 0;
  try {
    const llm = await host.invokeLLM(
      [{ role: 'user', content: buildContextPrompt(events, context) }],
      { tier: 'balanced' },
    );
    tokens_in = llm?.usage?.input_tokens ?? 0;
    tokens_out = llm?.usage?.output_tokens ?? 0;
    parsed = parseLLMJSON(llm?.content ?? '');
  } catch {
    return { record: null, tokens_in, tokens_out, cached: false };
  }

  const v = validateCommStyleShape(parsed);
  if (!v.ok) {
    return { record: null, tokens_in, tokens_out, cached: false };
  }

  // Resolve evidence event IDs from 1-indexed evidence_indices.
  const evidenceIds = [];
  for (const idx of parsed.evidence_indices ?? []) {
    const n = Number.parseInt(idx, 10);
    if (Number.isInteger(n) && n >= 1 && n <= events.length) {
      evidenceIds.push(String(events[n - 1].id));
    }
  }

  // Convergence: 2 consecutive synthesizes over matching evidence sets that
  // produce the same content_hash → converged (volatile=false).
  // When input_hash changes (new evidence), the streak resets to 1 — this is
  // the first synthesis of the new evidence set, so it's unconverged by
  // definition regardless of whether the shape matches the prior output.
  const content_hash = hashSignals([
    { id: 'shape', content: JSON.stringify(v.value) },
  ]);
  const inputChanged = prior?.input_hash !== input_hash;
  const prevConsec =
    !inputChanged && prior?.content_hash === content_hash ? (prior.consecutive_matches ?? 0) : 0;
  const consecutive_matches = prevConsec + 1;
  const volatile = consecutive_matches < 2;

  const record = {
    ...v.value,
    evidence: evidenceIds,
    input_hash,
    content_hash,
    consecutive_matches,
    volatile,
    evidence_count: events.length,
    context,
    last_synthesized_at: new Date().toISOString(),
  };

  return { record, tokens_in, tokens_out, cached: false };
}

// ---------------------------------------------------------------------------
// Public dream step
// ---------------------------------------------------------------------------

export async function dreamStepCommStyle(db, host) {
  // Layer 1: default synthesis (unchanged — delegates entirely to comm-style.js).
  let defaultResult;
  try {
    defaultResult = await synthesizeCommStyle(db, host);
    if (!defaultResult.ok) {
      console.warn(`[dream] step-comm-style default: ${defaultResult.reason ?? 'unknown'}`);
    }
  } catch (e) {
    console.warn(`[dream] step-comm-style default: ${e.message}`);
    defaultResult = { ok: false, reason: e.message };
  }

  // After default synthesis: write snapshot memo and update last_snapshot_id.
  // Skip when cached=true (synthesis short-circuited on identical input) — nothing changed.
  if (defaultResult?.ok && !defaultResult.cached && defaultResult.comm_style) {
    try {
      const cs = defaultResult.comm_style;
      const contentHash = createHash('sha256')
        .update(JSON.stringify(cs))
        .digest('hex')
        .slice(0, 16);
      const snapshotId = await writeCommStyleSnapshot(db, {
        context: 'default',
        synthesizedFields: cs,
        contentHash,
        volatile: cs.confidence == null || cs.confidence < 0.4,
        evidenceCount: defaultResult.signals_used ?? 0,
      });
      if (snapshotId) {
        // Patch persona:singleton.comm_style.last_snapshot_id.
        const [row] = await db
          .query(surql`SELECT comm_style FROM persona:singleton`)
          .collect()
          .then(([r]) => [r?.[0]]);
        const updated = { ...(row?.comm_style ?? {}), last_snapshot_id: snapshotId };
        await db
          .query(surql`UPSERT persona:singleton MERGE ${{ comm_style: updated }}`)
          .collect();
      }
    } catch (e) {
      console.warn(`[dream] step-comm-style default snapshot: ${e.message}`);
    }
  }

  // Layer 2: per-context synthesis.
  let perContextResult;
  try {
    perContextResult = await runPerContextSynthesis(db, host);
  } catch (e) {
    console.warn(`[dream] step-comm-style per-context: ${e.message}`);
    perContextResult = { ok: false, reason: e.message };
  }

  return {
    default: defaultResult,
    per_context: perContextResult,
    ok: defaultResult.ok,
  };
}

/**
 * Per-context synthesis entry point.
 * Reads all correction events, partitions by context, synthesizes each context
 * with ≥10 events, writes results to persona:singleton.comm_style_contexts.
 */
async function runPerContextSynthesis(db, host) {
  if (!host?.invokeLLM) {
    return { ok: false, reason: 'no_host', contexts_updated: 0, tokens_in: 0, tokens_out: 0 };
  }

  const cutoff = new Date(Date.now() - RECENCY_MS);
  const [rows] = await db
    .query(
      surql`SELECT id, content, ts, meta FROM events
            WHERE meta.kind = 'correction' AND ts > ${cutoff}
            ORDER BY ts DESC LIMIT ${SIGNAL_CAP}`,
    )
    .collect();
  const allEvents = rows ?? [];

  const buckets = partitionByContext(allEvents);
  const prior = (await getContexts(db)) ?? {
    discord: null,
    terminal: null,
    web: null,
  };

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let contextsUpdated = 0;

  const updated = {
    discord: prior.discord ?? null,
    terminal: prior.terminal ?? null,
    web: prior.web ?? null,
  };

  for (const ctx of CONTEXTS) {
    const events = buckets[ctx];
    if (events.length < PER_CONTEXT_MIN_SIGNALS) {
      // Leave existing record (or null) unchanged.
      continue;
    }

    const { record: rawRecord, tokens_in, tokens_out } = await synthesizeOneContext({
      events,
      context: ctx,
      prior: prior[ctx],
      host,
    });

    totalTokensIn += tokens_in;
    totalTokensOut += tokens_out;

    if (rawRecord !== null) {
      // Write snapshot memo for this context.
      let ctxRecord = rawRecord;
      try {
        const contentHash = ctxRecord.content_hash ?? createHash('sha256')
          .update(JSON.stringify(ctxRecord))
          .digest('hex')
          .slice(0, 16);
        const snapshotId = await writeCommStyleSnapshot(db, {
          context: ctx,
          synthesizedFields: ctxRecord,
          contentHash,
          volatile: ctxRecord.volatile ?? true,
          evidenceCount: ctxRecord.evidence_count ?? events.length,
        });
        if (snapshotId) {
          ctxRecord = { ...ctxRecord, last_snapshot_id: snapshotId };
        }
      } catch (e) {
        console.warn(`[dream] step-comm-style snapshot (${ctx}): ${e.message}`);
      }
      updated[ctx] = ctxRecord;
      contextsUpdated++;
    }
  }

  await setContexts(db, updated);

  return {
    ok: true,
    contexts_updated: contextsUpdated,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    session_context: resolveSessionContext(),
  };
}

// ---------------------------------------------------------------------------
// Inject helper: resolve effective comm-style for current session context.
//
// Callers (agents-md-refresh etc.) can use this to get the right style
// for the current ROBIN_SESSION_PLATFORM without knowing the storage layout.
// ---------------------------------------------------------------------------

/**
 * Read the comm_style_contexts from DB and return the effective context
 * record for the given (or auto-detected) context. Falls back to null when
 * no per-context record exists (caller should use the default comm_style).
 *
 * @param {object} db
 * @param {'discord'|'terminal'|'web'|null} [context] - null = auto-detect from env
 * @returns {Promise<object|null>}
 */
export async function getEffectiveContextCommStyle(db, context = null) {
  const ctx = context ?? resolveSessionContext();
  const ctxs = await getContexts(db);
  return ctxs?.[ctx] ?? null;
}
