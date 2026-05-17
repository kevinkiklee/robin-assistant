// task-taxonomy.js — bounded enum of task_type strings used by the introspection
// faculty and dream pipeline as identifiers.
//
// Free-form values are rejected at write time by validateTaskType().
// Adding new entries is a developer task in v1; dream-driven expansion is v2.

export const TASK_TYPE_PREFIXES = ['job', 'outbound', 'recall', 'turn'];

export const TURN_INTENTS = ['recommend', 'analyze', 'plan', 'execute_change', 'default'];
export const RECALL_INTENTS = ['person', 'past_session', 'domain_facts', 'default'];

// task_type validation: <prefix>:<rest>.
// - 'job:<name>'        — names match registered jobs (validated lazily; this module only checks the prefix)
// - 'outbound:<class>'  — class shape "<tool>:<action>" e.g. discord_send:send_dm; this module only checks prefix
// - 'recall:<intent>'   — intent must be in RECALL_INTENTS
// - 'turn:<intent>'     — intent must be in TURN_INTENTS

export function validateTaskType(taskType) {
  const parsed = parseTaskType(taskType);
  if (!parsed) {
    return {
      ok: false,
      reason: `task_type must be "<prefix>:<rest>"; got: ${JSON.stringify(taskType)}`,
    };
  }
  const { prefix, rest } = parsed;
  if (!TASK_TYPE_PREFIXES.includes(prefix)) {
    return {
      ok: false,
      reason: `unknown prefix "${prefix}"; allowed: ${TASK_TYPE_PREFIXES.join(', ')}`,
    };
  }
  if (prefix === 'turn' && !TURN_INTENTS.includes(rest)) {
    return {
      ok: false,
      reason: `unknown turn intent "${rest}"; allowed: ${TURN_INTENTS.join(', ')}`,
    };
  }
  if (prefix === 'recall' && !RECALL_INTENTS.includes(rest)) {
    return {
      ok: false,
      reason: `unknown recall intent "${rest}"; allowed: ${RECALL_INTENTS.join(', ')}`,
    };
  }
  return { ok: true };
}

export function parseTaskType(taskType) {
  if (typeof taskType !== 'string') return null;
  const idx = taskType.indexOf(':');
  if (idx < 1) return null;
  const prefix = taskType.slice(0, idx);
  const rest = taskType.slice(idx + 1);
  if (!rest) return null;
  return { prefix, rest };
}

// Token budget caps per prefix (used by playbook synthesis + inject path).
export const TOKEN_CAPS = {
  job: 1200,
  outbound: 400,
  recall: 600,
  turn: 800,
};

export function tokenCapForTaskType(taskType) {
  const parsed = parseTaskType(taskType);
  if (!parsed) return null;
  return TOKEN_CAPS[parsed.prefix] ?? null;
}
