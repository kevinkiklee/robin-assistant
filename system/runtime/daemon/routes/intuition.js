/**
 * Resolve the agent-host source for the focus block (spec §4.2 step 3).
 *
 * Priority: explicit body.source → host.name → most-recently-active
 * episode's source → null. Last-ditch episode lookup is bounded to a 60s
 * window so the recall path stays fast.
 */
async function resolveDaemonSource(db, body, host) {
  if (typeof body?.source === 'string' && body.source.length > 0) return body.source;
  if (host?.name) {
    if (host.name === 'claude-code') return 'agent:claude-code';
    if (host.name === 'gemini') return 'agent:gemini-cli';
    return `agent:${host.name}`;
  }
  try {
    const [rows] = await db
      .query(
        `SELECT VALUE source FROM episodes
         WHERE ended_at IS NONE
           AND last_event_at >= time::now() - 60s
         ORDER BY last_event_at DESC
         LIMIT 1`,
      )
      .collect();
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

const ERROR_RESPONSE = {
  block: '',
  hits: 0,
  tokens: 0,
  latency_ms: 0,
  focus_block: '',
  focus_tokens: 0,
  focus_suppressed_reason: 'error',
};

const NO_ENDPOINT_RESPONSE = {
  block: '',
  hits: 0,
  tokens: 0,
  latency_ms: 0,
  focus_block: '',
  focus_tokens: 0,
  focus_suppressed_reason: 'no_endpoint',
};

export const intuitionRoutes = [
  {
    method: 'POST',
    path: '/internal/intuition',
    async handler({ ctx, body }) {
      // Defensive dynamic import: intuitionEndpoint may not exist in every
      // install (the `.catch(() => ({}))` preserves the original behavior).
      const { intuitionEndpoint } = await import('../../../cognition/intuition/inject.js').catch(
        () => ({}),
      );
      const { getRecallConfig } = await import('../../../cognition/memory/store.js').catch(
        () => ({}),
      );
      if (typeof intuitionEndpoint !== 'function') {
        return NO_ENDPOINT_RESPONSE;
      }
      // D1 — resolve agent-host source for the focus block.
      const source = await resolveDaemonSource(ctx.db, body, ctx.host);
      // B2 — read runtime:recall at request time so the flag flip takes
      // effect on the next call (bounded by getRecallConfig's 5-s cache).
      let cfg = {};
      if (typeof getRecallConfig === 'function') {
        cfg = await getRecallConfig(ctx.db).catch(() => ({}));
      }
      const surfacingOn = cfg.conflict_surfacing_enabled === true;
      const tokenBudget =
        body.token_budget ?? body.tokenBudget ?? cfg.relevant_memory_token_budget ?? 1500;
      // Force the conflict budget to 0 when the flag is off so the
      // endpoint's flag-off branch matches pre-B2 behavior exactly.
      const conflictTokenBudget = surfacingOn ? (cfg.conflict_block_token_budget ?? 300) : 0;
      return await intuitionEndpoint({
        db: ctx.db,
        embedder: ctx.embedder.wrap,
        host: ctx.host ?? null,
        detector: ctx.detector,
        query: body.query ?? '',
        sessionId: body.session_id ?? body.sessionId ?? null,
        source,
        priorAssistant: body.prior_assistant ?? body.priorAssistant ?? '',
        k: body.k ?? 6,
        recencyDays: body.recency_days ?? body.recencyDays ?? 30,
        tokenBudget,
        conflictTokenBudget,
      }).catch(() => ERROR_RESPONSE);
    },
  },
];
