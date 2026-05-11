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
        return { block: '', hits: 0, tokens: 0, latency_ms: 0 };
      }
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
        detector: ctx.detector,
        query: body.query ?? '',
        sessionId: body.session_id ?? body.sessionId ?? null,
        priorAssistant: body.prior_assistant ?? body.priorAssistant ?? '',
        k: body.k ?? 6,
        recencyDays: body.recency_days ?? body.recencyDays ?? 30,
        tokenBudget,
        conflictTokenBudget,
      }).catch(() => ({ block: '', hits: 0, tokens: 0, latency_ms: 0 }));
    },
  },
];
