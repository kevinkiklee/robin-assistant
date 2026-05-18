// step-playbook-synthesis.js — Dream step: re-synthesize playbooks.
// L2 step, Opus-tier, capped at K=5/night. Depends on outcomeGrading + reflection.
// Spec §1 "step-playbook-synthesis" + §3 "Playbook content shape".
// FAIL-SOFT: an error here MUST NOT abort the Dream run.
import { surql } from 'surrealdb';
import { toRecordRef } from '../../data/db/record-ref.js';
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';
import { tokenCapForTaskType } from '../introspection/task-taxonomy.js';
import {
  buildSynthesisSystemPrompt,
  buildSynthesisUserPrompt,
  computeNormalizedDrift,
  estimateTokens,
  parsePlaybookOutput,
  truncateToTokens,
  validateFrontmatter,
} from './playbook-synthesis-prompt.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_K = 5; // Max task_types to synthesize per night
const DRIFT_THRESHOLD = 0.1; // Min normalized_drift to be eligible
const COLD_START_N_THRESHOLD = 5; // Min outcomes to transition cold_start → false
const COLD_START_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MIN_OUTCOMES_FOR_ELIGIBILITY = 3;

// ---------------------------------------------------------------------------
// Public dream step
// ---------------------------------------------------------------------------

/**
 * @param {import('surrealdb').Surreal} db
 * @param {object} host — HostAdapter
 * @param {object} [opts]
 * @param {number} [opts.k] — override K cap
 * @returns {Promise<object>}
 */
export async function dreamStepPlaybookSynthesis(db, host, opts = {}) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return { skipped: true, reason: 'v2_not_enabled', step: 'playbookSynthesis' };
  }

  try {
    return await runPlaybookSynthesis(db, host, opts);
  } catch (e) {
    console.warn(`[dream/playbook-synthesis] top-level error: ${e?.message ?? e}`);
    return {
      skipped: false,
      ok: false,
      reason: e?.message ?? String(e),
      step: 'playbookSynthesis',
    };
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function runPlaybookSynthesis(db, host, opts) {
  const K = typeof opts?.k === 'number' && opts.k > 0 ? opts.k : await readKConfig(db);

  // 1. Read all graded task_outcome memos
  const allOutcomes = await fetchAllGradedOutcomes(db);

  // 2. Group by task_type
  const byType = groupByTaskType(allOutcomes);

  // 3. For each group, determine eligibility + compute drift × n rank
  const eligible = [];
  for (const [taskType, outcomes] of byType.entries()) {
    const activePb = await fetchActivePlaybook(db, taskType);
    const since = activePb?.meta?.last_synthesized_at
      ? new Date(activePb.meta.last_synthesized_at)
      : null;

    // Count graded since last synthesis (or all-time if no playbook)
    const outcomesSince = since ? outcomes.filter((o) => new Date(o.derived_at) > since) : outcomes;
    const n = outcomesSince.filter((o) => typeof o?.meta?.score === 'number').length;

    if (n < MIN_OUTCOMES_FOR_ELIGIBILITY) continue;

    // Sort by derived_at ascending for drift computation
    const sorted = [...outcomesSince].sort(
      (a, b) => new Date(a.derived_at) - new Date(b.derived_at),
    );
    const drift = computeNormalizedDrift(sorted);

    // Skip if drift is below threshold AND active playbook is fresh (<= 14 days)
    if (activePb) {
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
      const age = since ? Date.now() - since.getTime() : Infinity;
      if (drift < DRIFT_THRESHOLD && age <= fourteenDaysMs) continue;
    }

    eligible.push({ taskType, outcomes, outcomesSince, n, drift, activePb });
  }

  // 4. Rank by drift × n descending, take top K
  eligible.sort((a, b) => b.drift * b.n - a.drift * a.n);
  const selected = eligible.slice(0, K);

  // 5. Synthesize each selected task_type
  let synthesized = 0;
  let errors = 0;
  let overflows = 0;
  let tokens_in = 0;
  let tokens_out = 0;

  for (const group of selected) {
    try {
      const result = await synthesizeOnePlaybook(db, host, group);
      tokens_in += result.tokens_in ?? 0;
      tokens_out += result.tokens_out ?? 0;
      if (result.overflow) overflows++;
      synthesized++;
    } catch (e) {
      console.warn(`[dream/playbook-synthesis] ${group.taskType} failed: ${e?.message ?? e}`);
      errors++;
    }
  }

  // 6. Cold-start transition: flip cold_start=false for eligible cold-start playbooks
  await transitionColdStartPlaybooks(db, allOutcomes);

  return {
    skipped: false,
    ok: true,
    eligible_count: eligible.length,
    selected_count: selected.length,
    synthesized,
    skipped_task_types: 0,
    errors,
    overflows,
    tokens_in,
    tokens_out,
    step: 'playbookSynthesis',
  };
}

// ---------------------------------------------------------------------------
// Per-task_type synthesis
// ---------------------------------------------------------------------------

async function synthesizeOnePlaybook(db, host, { taskType, outcomesSince, n, activePb }) {
  if (!host?.invokeLLM) {
    throw new Error('no host adapter');
  }

  const lengthCap = tokenCapForTaskType(taskType) ?? 800;

  // Determine version number
  const currentVersion = activePb?.meta?.version ?? 0;
  const newVersion = currentVersion + 1;
  const coldStart = n < COLD_START_N_THRESHOLD;

  // Fetch related rules (task_type ∈ relates_to_task_types)
  const relatedRules = await fetchRelatedRules(db, taskType);

  // Build prompts
  const systemPrompt = buildSynthesisSystemPrompt(lengthCap);
  const userPrompt = buildSynthesisUserPrompt({
    taskType,
    version: newVersion,
    coldStart,
    signalCount: n,
    priorPlaybookContent: typeof activePb?.content === 'string' ? activePb.content : null,
    outcomes: outcomesSince.slice(0, 20), // cap evidence in prompt
    rules: relatedRules,
  });

  // LLM call — tier: 'deep' maps to Opus per CLAUDE_TIER_MAP
  let llmResult;
  let overflow = false;

  llmResult = await host.invokeLLM([{ role: 'user', content: userPrompt }], {
    tier: 'deep',
    system: [{ role: 'system', content: systemPrompt, cache_control: { type: 'ephemeral' } }],
  });

  let { frontmatter, body } = parsePlaybookOutput(llmResult?.content ?? '');

  // Token cap enforcement — check and retry if needed
  const bodyTokens = estimateTokens(body);
  if (bodyTokens > lengthCap) {
    // One retry with tighter target
    const tighterTokens = Math.round(lengthCap * 0.7);
    const retryPrompt = buildSynthesisUserPrompt({
      taskType,
      version: newVersion,
      coldStart,
      signalCount: n,
      priorPlaybookContent: typeof activePb?.content === 'string' ? activePb.content : null,
      outcomes: outcomesSince.slice(0, 20),
      rules: relatedRules,
    });
    const retrySystem = buildSynthesisSystemPrompt(tighterTokens);

    const retryResult = await host.invokeLLM([{ role: 'user', content: retryPrompt }], {
      tier: 'deep',
      system: [{ role: 'system', content: retrySystem, cache_control: { type: 'ephemeral' } }],
    });
    llmResult.usage = llmResult.usage ?? {};
    llmResult.usage.input_tokens =
      (llmResult.usage.input_tokens ?? 0) + (retryResult?.usage?.input_tokens ?? 0);
    llmResult.usage.output_tokens =
      (llmResult.usage.output_tokens ?? 0) + (retryResult?.usage?.output_tokens ?? 0);

    const retryParsed = parsePlaybookOutput(retryResult?.content ?? '');
    const retryBodyTokens = estimateTokens(retryParsed.body);

    if (retryBodyTokens <= lengthCap) {
      frontmatter = retryParsed.frontmatter;
      body = retryParsed.body;
    } else {
      // Hard truncate — use retry output but truncate body
      frontmatter = retryParsed.frontmatter ?? frontmatter;
      body = truncateToTokens(retryParsed.body ?? body, lengthCap);
      overflow = true;
      // Log overflow event via console — record_event is the right path but we
      // stay within the dream step's own logging layer to avoid coupling.
      console.warn(
        `[dream/playbook-synthesis] playbook_synthesis_overflow: task_type=${taskType} retried=true truncated to ${lengthCap} tokens`,
      );
    }
  }

  const tokensIn = llmResult?.usage?.input_tokens ?? 0;
  const tokensOut = llmResult?.usage?.output_tokens ?? 0;

  // Validate frontmatter
  const validation = validateFrontmatter(frontmatter);
  if (!validation.ok) {
    throw new Error(`frontmatter validation failed: missing ${validation.missing.join(', ')}`);
  }

  // Build the full content string: reconstruct YAML frontmatter + body
  // Code populates evidence_outcomes and related_rules (not LLM)
  const now = new Date().toISOString();
  const evidenceOutcomeIds = outcomesSince.slice(0, 10).map((o) => String(o.id));
  // Keep both native RecordId (for DB ops) and string (for content embedding)
  const relatedRuleNativeIds = relatedRules.map((r) => r.id);
  const relatedRuleIds = relatedRules.map((r) => String(r.id));

  const fullContent = buildPlaybookContent({
    taskType,
    version: newVersion,
    coldStart,
    signalCount: n,
    lengthCap,
    now,
    evidenceOutcomeIds,
    relatedRuleIds,
    body,
  });

  // Write transaction: CREATE new playbook, then supersede prior
  const newId = await writeNewPlaybook(db, {
    taskType,
    version: newVersion,
    coldStart,
    signalCount: n,
    lengthCap,
    now,
    evidenceOutcomeIds,
    relatedRuleIds,
    content: fullContent,
  });

  // Supersede prior active playbook
  if (activePb?.id) {
    await supersedePlaybook(db, activePb.id, newId);
  }

  // Write cited_by backpointers on each cited rule (use native RecordId for DB ops)
  for (let i = 0; i < relatedRuleNativeIds.length; i++) {
    const nativeRuleId = relatedRuleNativeIds[i];
    const ruleIdStr = relatedRuleIds[i];
    await writeCitedByBackpointer(db, nativeRuleId, newId).catch((e) => {
      console.warn(
        `[dream/playbook-synthesis] cited_by backpointer failed for rule ${ruleIdStr}: ${e?.message ?? e}`,
      );
    });
  }

  return { tokens_in: tokensIn, tokens_out: tokensOut, overflow, newId: String(newId) };
}

// ---------------------------------------------------------------------------
// Playbook content builder
// ---------------------------------------------------------------------------

function buildPlaybookContent({
  taskType,
  version,
  coldStart,
  signalCount,
  lengthCap,
  now,
  evidenceOutcomeIds,
  relatedRuleIds,
  body,
}) {
  const evidenceStr = evidenceOutcomeIds.length > 0 ? `[${evidenceOutcomeIds.join(', ')}]` : '[]';
  const rulesStr = relatedRuleIds.length > 0 ? `[${relatedRuleIds.join(', ')}]` : '[]';

  const frontmatter = [
    '---',
    `task_type: ${taskType}`,
    `version: ${version}`,
    `active: true`,
    `cold_start: ${coldStart}`,
    `trust: trusted`,
    `signal_count: ${signalCount}`,
    `declared_sections: []`,
    `length_cap_tokens: ${lengthCap}`,
    `last_synthesized_at: ${now}`,
    `evidence_outcomes: ${evidenceStr}`,
    `related_rules: ${rulesStr}`,
    '---',
  ].join('\n');

  return `${frontmatter}\n${body}`;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function readKConfig(db) {
  try {
    const [rows] = await db
      .query(`SELECT VALUE value FROM runtime:\`self-improvement-v2\``)
      .collect();
    const v = Array.isArray(rows) ? rows[0] : rows;
    const k = v?.playbook_synthesis_k;
    if (typeof k === 'number' && Number.isInteger(k) && k > 0) return k;
  } catch {
    // absent / error → use default
  }
  return DEFAULT_K;
}

async function fetchAllGradedOutcomes(db) {
  try {
    const [rows] = await db
      .query(
        `SELECT id, content, derived_at, meta FROM memos
         WHERE kind = 'task_outcome'
           AND meta.score IS NOT NONE
         ORDER BY derived_at ASC`,
      )
      .collect();
    return Array.isArray(rows) ? rows.filter(Boolean) : [];
  } catch (e) {
    console.warn(`[dream/playbook-synthesis] fetchAllGradedOutcomes: ${e?.message ?? e}`);
    return [];
  }
}

function groupByTaskType(outcomes) {
  const map = new Map();
  for (const o of outcomes) {
    const tt = o?.meta?.task_type;
    if (!tt) continue;
    if (!map.has(tt)) map.set(tt, []);
    map.get(tt).push(o);
  }
  return map;
}

async function fetchActivePlaybook(db, taskType) {
  try {
    const [rows] = await db
      .query(
        surql`SELECT * FROM memos
              WHERE kind = 'playbook'
                AND meta.task_type = ${taskType}
                AND meta.active = true
              ORDER BY derived_at DESC
              LIMIT 1`,
      )
      .collect();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0] ?? null;
  } catch (e) {
    console.warn(`[dream/playbook-synthesis] fetchActivePlaybook(${taskType}): ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Fetch active rules where relates_to_task_types contains the given taskType.
 *
 * `relates_to_task_types` is not yet a SCHEMAFULL field on rules — it is stored
 * in `meta.relates_to_task_types` (FLEXIBLE meta object) for forward-compat
 * until the schema migration (W2-B) lands. We read from both locations and merge.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {string} taskType
 * @returns {Promise<Array<{id: string, content: string}>>}
 */
async function fetchRelatedRules(db, taskType) {
  try {
    // Fetch all active rules; filter in JS since SurrealQL array membership
    // on FLEXIBLE meta fields requires a full table scan either way, and
    // the rules table is small (typically <200 rows).
    const [rows] = await db
      .query(
        `SELECT id, content, relates_to_task_types, meta FROM rules
         WHERE active = true`,
      )
      .collect();

    if (!Array.isArray(rows)) return [];

    return rows.filter((r) => {
      // Check top-level relates_to_task_types (from schema migration when/if landed)
      const topLevel = r?.relates_to_task_types;
      if (Array.isArray(topLevel) && topLevel.includes(taskType)) return true;
      // Check meta.relates_to_task_types (flexible fallback)
      const inMeta = r?.meta?.relates_to_task_types;
      if (Array.isArray(inMeta) && inMeta.includes(taskType)) return true;
      return false;
    });
  } catch (e) {
    console.warn(`[dream/playbook-synthesis] fetchRelatedRules(${taskType}): ${e?.message ?? e}`);
    return [];
  }
}

async function writeNewPlaybook(
  db,
  {
    taskType,
    version,
    coldStart,
    signalCount,
    lengthCap,
    now,
    evidenceOutcomeIds,
    relatedRuleIds,
    content,
  },
) {
  const [rows] = await db
    .query(
      surql`CREATE memos CONTENT ${{
        kind: 'playbook',
        content,
        derived_by: 'dream:playbook-synthesis',
        scope: 'global',
        tags: ['playbook', taskType],
        meta: {
          task_type: taskType,
          version: version,
          active: true,
          cold_start: coldStart,
          trust: 'trusted',
          signal_count: signalCount,
          length_cap_tokens: lengthCap,
          last_synthesized_at: now,
          evidence_outcomes: evidenceOutcomeIds,
          related_rules: relatedRuleIds,
          declared_sections: [],
        },
      }}`,
    )
    .collect();

  const created = Array.isArray(rows) ? rows[0] : rows;
  if (!created?.id) throw new Error('writeNewPlaybook: no id returned from CREATE');
  return created.id;
}

async function supersedePlaybook(db, priorId, newId) {
  try {
    await db
      .query(
        surql`UPDATE ONLY ${toRecordRef(priorId)} SET
              meta.active = false,
              meta.superseded_by = ${String(newId)}`,
      )
      .collect();
  } catch (e) {
    console.warn(
      `[dream/playbook-synthesis] supersedePlaybook(${String(priorId)}): ${e?.message ?? e}`,
    );
  }
}

async function writeCitedByBackpointer(db, ruleId, playbookId) {
  // Read existing cited_by, append newId, write back.
  // Rules are SCHEMAFULL — cited_by is not a declared field, so it lives in meta.
  const [rows] = await db
    .query(surql`SELECT meta FROM rules WHERE id = ${ruleId} LIMIT 1`)
    .collect();
  const existing = Array.isArray(rows) ? rows[0] : rows;
  const priorCitedBy = Array.isArray(existing?.meta?.cited_by) ? existing.meta.cited_by : [];

  const pbStr = String(playbookId);
  if (!priorCitedBy.includes(pbStr)) {
    await db
      .query(
        surql`UPDATE ONLY ${toRecordRef(ruleId)} SET meta.cited_by = ${[...priorCitedBy, pbStr]}`,
      )
      .collect();
  }
}

// ---------------------------------------------------------------------------
// Cold-start transition
// ---------------------------------------------------------------------------

/**
 * Flip cold_start=false for any cold_start=true playbook that has:
 *   - ≥ COLD_START_N_THRESHOLD graded outcomes for its task_type since its synthesis
 *   - last_synthesized_at is at least COLD_START_AGE_MS ago
 */
async function transitionColdStartPlaybooks(db, allOutcomes) {
  try {
    const [rows] = await db
      .query(
        `SELECT * FROM memos
         WHERE kind = 'playbook'
           AND meta.active = true
           AND meta.cold_start = true`,
      )
      .collect();

    if (!Array.isArray(rows) || rows.length === 0) return;

    const outcomesByType = groupByTaskType(allOutcomes);

    for (const pb of rows) {
      const taskType = pb?.meta?.task_type;
      if (!taskType) continue;

      const synthesizedAt = pb?.meta?.last_synthesized_at
        ? new Date(pb.meta.last_synthesized_at)
        : null;
      if (!synthesizedAt) continue;

      // Check age: ≥ 3 days since cold_start synthesis
      const ageMs = Date.now() - synthesizedAt.getTime();
      if (ageMs < COLD_START_AGE_MS) continue;

      // Count graded outcomes since cold_start synthesis
      const typeOutcomes = outcomesByType.get(taskType) ?? [];
      const gradedSince = typeOutcomes.filter(
        (o) => typeof o?.meta?.score === 'number' && new Date(o.derived_at) > synthesizedAt,
      ).length;

      if (gradedSince >= COLD_START_N_THRESHOLD) {
        try {
          await db.query(surql`UPDATE ONLY ${pb.id} SET meta.cold_start = false`).collect();
        } catch (e) {
          console.warn(
            `[dream/playbook-synthesis] cold_start transition failed for ${String(pb.id)}: ${e?.message ?? e}`,
          );
        }
      }
    }
  } catch (e) {
    console.warn(`[dream/playbook-synthesis] transitionColdStartPlaybooks: ${e?.message ?? e}`);
  }
}
