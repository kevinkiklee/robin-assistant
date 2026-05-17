// system/cognition/dream/comm-style-context-router.js
//
// Routes correction events to comm-style contexts (discord / terminal / web)
// based on event metadata, and resolves the current session context from
// ROBIN_SESSION_PLATFORM.

export const CONTEXTS = /** @type {const} */ (['discord', 'terminal', 'web']);

/**
 * Resolve the current session's context from environment.
 * @returns {'discord'|'terminal'|'web'}
 */
export function resolveSessionContext() {
  const platform = process.env.ROBIN_SESSION_PLATFORM;
  if (platform === 'discord') return 'discord';
  if (platform === 'web') return 'web';
  return 'terminal';
}

/**
 * Infer the comm-style context for a single event row.
 * Priority: meta.platform → meta.channel → session_source heuristics → 'terminal'.
 *
 * @param {object} event
 * @returns {'discord'|'terminal'|'web'}
 */
export function inferEventContext(event) {
  const meta = event?.meta ?? {};

  if (meta.platform === 'discord' || meta.channel === 'discord') return 'discord';
  if (meta.platform === 'web') return 'web';

  // session_source heuristic: "askrobin" in any source-URL field signals web.
  const src = String(meta.session_source ?? '').toLowerCase();
  if (src.includes('askrobin')) return 'web';

  return 'terminal';
}

/**
 * Partition a list of correction events into per-context buckets.
 *
 * @param {Array<object>} events
 * @returns {Record<'discord'|'terminal'|'web', Array<object>>}
 */
export function partitionByContext(events) {
  const buckets = { discord: [], terminal: [], web: [] };
  for (const ev of events) {
    buckets[inferEventContext(ev)].push(ev);
  }
  return buckets;
}
