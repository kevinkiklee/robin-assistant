// turn-classifier.js — Haiku-tier task-type classifier for the inject path.
//
// Three-tier lookup:
//   Tier 1 (declared)  — turnContext.task_type is already set → use it directly.
//   Tier 2 (routed)    — recall queries matched by a keyword/regex table.
//   Tier 3 (classified) — general assistant turns: Haiku call, budget-gated,
//                         per-session cache, empty-playbook-set short-circuit.
//
// This module is extracted from playbook-inject.js for unit-testability.
// Classifier state (session cache) is in-process only; not persisted.

import { readBudgetConfig, readBudgetState } from '../introspection/budget.js';
import { validateTaskType } from '../introspection/task-taxonomy.js';
import { cosineSim } from './vectors.js';

// ── Per-session cache ────────────────────────────────────────────────────────
// Map<sessionId, { taskType: string, vector: Float32Array|null, message: string }>
const _sessionCache = new Map();

export function _clearCacheForTest() {
  _sessionCache.clear();
}

// ── Recall routing table (Tier 2) ───────────────────────────────────────────
// Ordered: first match wins.
// Patterns are intentionally specific to memory-recall queries; generic
// questions ("what is 2 + 2") must NOT match.
const RECALL_ROUTES = [
  { pattern: /\b(who is|who was|tell me about|what do (i|you) know about)\b/i, intent: 'recall:person' },
  { pattern: /\b(last (session|time|week|month)|what did (i|you) (work on|say|mention|discuss)|have (i|you) (mentioned|talked|said|discussed))\b/i, intent: 'recall:past_session' },
  { pattern: /\b(recall\b|search (my|the) (memory|memories)|look up (in )?(my|the) memory)\b/i, intent: 'recall:domain_facts' },
  { pattern: /\bdo (i|you) know (my |the )?(preferences?|goals?|settings?|habits?)\b/i, intent: 'recall:domain_facts' },
];

/**
 * Route a message to a recall:* intent via pattern table.
 * Returns null when no pattern matches.
 *
 * @param {string} message
 * @returns {string|null}
 */
export function routeRecallIntent(message) {
  if (typeof message !== 'string' || !message.trim()) return null;
  for (const { pattern, intent } of RECALL_ROUTES) {
    if (pattern.test(message)) return intent;
  }
  return null;
}

// ── Empty-playbook-set short-circuit ─────────────────────────────────────────

/**
 * Returns true when at least one active turn:* playbook memo exists.
 * On any DB error returns false (treat as no playbooks → skip classifier).
 *
 * @param {import('surrealdb').Surreal} db
 * @returns {Promise<boolean>}
 */
export async function hasTurnPlaybooks(db) {
  try {
    const [rows] = await db
      .query(
        `SELECT count() AS n FROM memos
          WHERE kind = 'playbook'
            AND string::starts_with(meta.task_type, 'turn:')
            AND meta.active = true
          GROUP ALL`,
      )
      .collect();
    const row = Array.isArray(rows) ? rows[0] : rows;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

// ── Budget gate ──────────────────────────────────────────────────────────────
const BUDGET_THRESHOLD_USD = 0.05;

/**
 * Returns true when the introspection budget has at least $0.05 remaining.
 * On DB error returns false (budget unknown → skip classifier).
 *
 * @param {import('surrealdb').Surreal} db
 * @returns {Promise<boolean>}
 */
export async function isBudgetSufficient(db) {
  try {
    const [cfg, state] = await Promise.all([readBudgetConfig(db), readBudgetState(db)]);
    const remaining = (cfg.daily_cost_budget_usd ?? 0) - (state.daily_spend_usd ?? 0);
    return remaining >= BUDGET_THRESHOLD_USD;
  } catch {
    return false;
  }
}

// ── Cache invalidation ───────────────────────────────────────────────────────
const CACHE_SIMILARITY_THRESHOLD = 0.3;

/**
 * Determine whether the cached entry for this session is still valid
 * for the current message. Uses cosine similarity when both the current
 * and cached message were embedded; otherwise considers the cache cold.
 *
 * @param {string} sessionId
 * @param {string} message
 * @param {{embed:(t:string)=>Promise<Float32Array>}|null} embedder
 * @returns {Promise<{hit: boolean, entry: object|null}>}
 */
export async function checkSessionCache(sessionId, message, embedder) {
  const entry = _sessionCache.get(sessionId);
  if (!entry) return { hit: false, entry: null };

  // If no embedder available, treat as cold (conservative).
  if (!embedder?.embed) return { hit: false, entry: null };

  try {
    // Embed the current message and compare to the cached vector.
    const currentVec = await embedder.embed(message);
    if (!currentVec || !entry.vector) return { hit: false, entry: null };
    const sim = cosineSim(currentVec, entry.vector);
    if (sim >= CACHE_SIMILARITY_THRESHOLD) {
      return { hit: true, entry };
    }
    return { hit: false, entry: null };
  } catch {
    // Embedding error → treat as cold.
    return { hit: false, entry: null };
  }
}

// ── Haiku classifier ─────────────────────────────────────────────────────────
const CLASSIFIER_SYSTEM = 'You are a concise intent classifier. Respond with only the intent string — no explanation, no punctuation.';
const CLASSIFIER_PROMPT =
  'Classify this assistant-turn intent into one of: `turn:recommend`, `turn:analyze`, `turn:plan`, `turn:execute_change`, `turn:default`. Return only the intent string.';
const MAX_MESSAGE_CHARS = 2000; // ~500 tokens at chars/4

/**
 * Classify a user message into a turn:* intent using the Haiku LLM tier.
 * Returns 'turn:default' on any error.
 *
 * @param {string} message
 * @param {{invokeLLM: Function}} host
 * @returns {Promise<string>}
 */
export async function classifyWithHaiku(message, host) {
  const truncated = [...message].slice(0, MAX_MESSAGE_CHARS).join('');
  const userPrompt = `${CLASSIFIER_PROMPT}\n\nUser message:\n${truncated}`;

  try {
    const r = await host.invokeLLM([{ role: 'user', content: userPrompt }], {
      tier: 'fast',
      system: [{ role: 'system', content: CLASSIFIER_SYSTEM }],
      maxTokens: 20,
    });
    const raw = typeof r?.content === 'string' ? r.content.trim() : '';
    const validation = validateTaskType(raw);
    if (validation.ok) return raw;
    // Strip surrounding backticks if present (LLM sometimes echoes the format).
    const stripped = raw.replace(/^`|`$/g, '').trim();
    const v2 = validateTaskType(stripped);
    if (v2.ok) return stripped;
    return 'turn:default';
  } catch (err) {
    console.warn('[turn-classifier] Haiku classify error:', err?.message ?? err);
    return 'turn:default';
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Classify a turn into a task_type string using three-tier lookup:
 *   Tier 1: declared task_type in turnContext → use directly.
 *   Tier 2: recall queries → route by pattern.
 *   Tier 3: general turns → Haiku classifier (budget-gated, cache-aware).
 *
 * Always returns a valid task_type string; never throws.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {object} [turnContext]
 * @param {string} [turnContext.task_type]  Pre-declared type (jobs, outbound writes).
 * @param {string} [turnContext.query]      Current user message.
 * @param {string} [turnContext.session_id] Session ID for per-session cache.
 * @param {{invokeLLM: Function}} [host]    Host adapter. When absent, Tier 3 is skipped.
 * @param {{embed:(t:string)=>Promise<Float32Array>}} [embedder]  For cache similarity.
 * @returns {Promise<string>}
 */
export async function classifyTurnType(db, turnContext, host, embedder) {
  try {
    const ctx = turnContext ?? {};
    const message = typeof ctx.query === 'string' ? ctx.query : '';
    const sessionId = typeof ctx.session_id === 'string' ? ctx.session_id : null;

    // ── Tier 1: declared ─────────────────────────────────────────────────────
    if (typeof ctx.task_type === 'string' && ctx.task_type.length > 0) {
      const v = validateTaskType(ctx.task_type);
      if (v.ok) return ctx.task_type;
    }

    // ── Tier 2: recall routing ───────────────────────────────────────────────
    const recallIntent = routeRecallIntent(message);
    if (recallIntent) return recallIntent;

    // ── Tier 3: Haiku classifier ─────────────────────────────────────────────
    // Requires a host; skip if not available.
    if (!host?.invokeLLM) return 'turn:default';

    // Skip if no turn:* playbooks exist (nothing to inject anyway).
    const hasPlaybooks = await hasTurnPlaybooks(db);
    if (!hasPlaybooks) return 'turn:default';

    // Budget gate.
    const budgetOk = await isBudgetSufficient(db);
    if (!budgetOk) return 'turn:default';

    // Per-session cache check.
    if (sessionId && message) {
      const { hit, entry } = await checkSessionCache(sessionId, message, embedder);
      if (hit && entry) return entry.taskType;
    }

    // Call Haiku.
    const taskType = await classifyWithHaiku(message, host);

    // Store result in session cache (with vector if embedder available).
    if (sessionId) {
      let vector = null;
      if (embedder?.embed && message) {
        try {
          vector = await embedder.embed(message);
        } catch {
          // Cache without vector; next call will be cold.
        }
      }
      _sessionCache.set(sessionId, { taskType, vector, message });
    }

    return taskType;
  } catch (err) {
    console.warn('[turn-classifier] classifyTurnType error:', err?.message ?? err);
    return 'turn:default';
  }
}
