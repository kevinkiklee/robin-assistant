// playbook-synthesis-prompt.js — Prompt construction, output parser, and drift math
// for the step-playbook-synthesis dream step.
//
// Spec §1 "step-playbook-synthesis" + §3 "Playbook content shape".

// ---------------------------------------------------------------------------
// Token estimation (chars/4 heuristic, consistent with inject.js and grading)
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a string using the chars/4 heuristic.
 *
 * @param {string} s
 * @returns {number}
 */
export function estimateTokens(s) {
  return Math.ceil((typeof s === 'string' ? s.length : 0) / 4);
}

/**
 * Truncate a string to fit within a token budget using chars/4 heuristic.
 *
 * @param {string} s
 * @param {number} capTokens
 * @returns {string}
 */
export function truncateToTokens(s, capTokens) {
  if (typeof s !== 'string') return '';
  if (estimateTokens(s) <= capTokens) return s;
  return [...s].slice(0, capTokens * 4).join('');
}

// ---------------------------------------------------------------------------
// Drift math — spec §1 "Selection"
// ---------------------------------------------------------------------------

/**
 * Compute normalized_drift for a list of graded task_outcome rows ordered by
 * derived_at (ascending).
 *
 * normalized_drift = mean(|Δscore| between consecutive rows) × (n / (n + 5))
 *
 * Returns 0 when fewer than 2 scored rows exist (no consecutive pair to compare).
 *
 * @param {Array<{meta: {score: number|null}, derived_at: string}>} rows
 * @returns {number}
 */
export function computeNormalizedDrift(rows) {
  // Filter to rows with non-null scores
  const scored = rows.filter((r) => typeof r?.meta?.score === 'number');
  const n = scored.length;
  if (n < 2) return 0;

  let sumDelta = 0;
  let pairs = 0;
  for (let i = 1; i < scored.length; i++) {
    const prev = scored[i - 1].meta.score;
    const curr = scored[i].meta.score;
    if (typeof prev === 'number' && typeof curr === 'number') {
      sumDelta += Math.abs(curr - prev);
      pairs++;
    }
  }

  if (pairs === 0) return 0;
  const meanDelta = sumDelta / pairs;
  return meanDelta * (n / (n + 5));
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Minimal YAML frontmatter parser for the `---\n...\n---` convention.
 * Only handles simple `key: value` pairs (scalars, arrays on one line, booleans,
 * numbers). Arrays in `[a, b]` inline form are supported. Returns null if the
 * frontmatter block cannot be parsed.
 *
 * @param {string} text
 * @returns {{ frontmatter: Record<string, unknown> | null, body: string }}
 */
export function parsePlaybookOutput(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';

  const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: trimmed };
  }

  const yamlBlock = match[1];
  const body = match[2].trimStart();
  const frontmatter = {};

  for (const line of yamlBlock.split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w_]*):\s*(.*)/);
    if (!kv) continue;
    const key = kv[1];
    const raw = kv[2].trim();

    // Inline array: [a, b, c]
    if (raw.startsWith('[') && raw.endsWith(']')) {
      frontmatter[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      continue;
    }
    // Boolean
    if (raw === 'true') {
      frontmatter[key] = true;
      continue;
    }
    if (raw === 'false') {
      frontmatter[key] = false;
      continue;
    }
    // Number
    const n = Number(raw);
    if (!Number.isNaN(n) && raw !== '') {
      frontmatter[key] = n;
      continue;
    }
    // String (strip optional quotes)
    frontmatter[key] = raw.replace(/^['"]|['"]$/g, '');
  }

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Required frontmatter field validation
// ---------------------------------------------------------------------------

const REQUIRED_FRONTMATTER_FIELDS = [
  'task_type',
  'version',
  'active',
  'cold_start',
  'signal_count',
  'declared_sections',
];

/**
 * Validate that all required frontmatter fields are present.
 *
 * @param {Record<string, unknown>} fm
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function validateFrontmatter(fm) {
  if (!fm || typeof fm !== 'object') return { ok: false, missing: REQUIRED_FRONTMATTER_FIELDS };
  const missing = REQUIRED_FRONTMATTER_FIELDS.filter((f) => !(f in fm));
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the synthesis system prompt.
 *
 * @param {number} lengthCapTokens
 * @returns {string}
 */
export function buildSynthesisSystemPrompt(lengthCapTokens) {
  const targetTokens = Math.round(lengthCapTokens * 0.8);
  return `You synthesize playbooks — markdown recipes for executing a task type well.

Output ONLY YAML frontmatter + body. No prose before or after.

Frontmatter must use this exact shape:
---
task_type: <string>
version: <int>
active: true
cold_start: <bool>
trust: trusted
signal_count: <int>
declared_sections: [section1, section2, ...]
length_cap_tokens: ${lengthCapTokens}
last_synthesized_at: <ISO datetime>
evidence_outcomes: []
related_rules: []
---

Rules for the body:
- Body MUST stay under ${targetTokens} tokens (target). Hard cap is ${lengthCapTokens} tokens.
- Use markdown with headers for each declared section.
- Rule citations: when the user has approved a rule that overlaps with what you are about to write, defer to the rule by id instead of duplicating its content. Use the format: "→ Rule <id>: <brief rationale>".
- Be concrete and actionable. Avoid generalities.
- Do NOT populate evidence_outcomes or related_rules — leave them as empty arrays []. The code fills these in from the actual evidence and rule IDs.`;
}

/**
 * Build the synthesis user prompt.
 *
 * @param {object} opts
 * @param {string} opts.taskType
 * @param {number} opts.version - version number for the new playbook
 * @param {boolean} opts.coldStart
 * @param {number} opts.signalCount
 * @param {string|null} opts.priorPlaybookContent - content of the current active playbook (if any)
 * @param {Array<{id: string, meta: object, content: string}>} opts.outcomes - graded outcomes
 * @param {Array<{id: string, content: string}>} opts.rules - active rules with relates_to_task_types
 * @returns {string}
 */
export function buildSynthesisUserPrompt({
  taskType,
  version,
  coldStart,
  signalCount,
  priorPlaybookContent,
  outcomes,
  rules,
}) {
  const lines = [];
  lines.push(`Task type: ${taskType}`);
  lines.push(`Version to write: ${version}`);
  lines.push(`Cold start: ${coldStart}`);
  lines.push(`Signal count: ${signalCount}`);
  lines.push('');

  if (priorPlaybookContent) {
    lines.push("=== PRIOR PLAYBOOK (for reference — update, don't preserve blindly) ===");
    // Cap prior playbook to ~3000 chars to control prompt size
    const capped =
      priorPlaybookContent.length > 3000
        ? `${priorPlaybookContent.slice(0, 3000)}\n[truncated]`
        : priorPlaybookContent;
    lines.push(capped);
    lines.push('');
  } else {
    lines.push('=== PRIOR PLAYBOOK ===');
    lines.push('(none — first version for this task_type)');
    lines.push('');
  }

  lines.push('=== EVIDENCE OUTCOMES (graded, most informative first) ===');
  if (outcomes && outcomes.length > 0) {
    for (const oc of outcomes) {
      const score = oc.meta?.score != null ? oc.meta.score.toFixed(2) : 'null';
      const taskId = oc.meta?.task_id ?? '';
      // Up to 3 lines of content excerpt
      const excerpt =
        typeof oc.content === 'string' ? oc.content.split('\n').slice(0, 3).join(' | ') : '';
      lines.push(`- id=${String(oc.id)} task_id=${taskId} score=${score}: ${excerpt}`);
    }
  } else {
    lines.push('(none — cold start with no prior outcomes)');
  }
  lines.push('');

  if (rules && rules.length > 0) {
    lines.push('=== ACTIVE RULES TO CITE (defer to these rather than duplicating) ===');
    for (const rule of rules) {
      // Up to 2 lines of rule content
      const excerpt =
        typeof rule.content === 'string' ? rule.content.split('\n').slice(0, 2).join(' | ') : '';
      lines.push(`- Rule id=${String(rule.id)}: ${excerpt}`);
    }
    lines.push('');
  }

  lines.push('Synthesize the playbook now. Output ONLY YAML frontmatter + body.');
  return lines.join('\n');
}
