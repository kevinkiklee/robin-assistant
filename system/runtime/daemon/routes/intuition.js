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
      if (typeof intuitionEndpoint === 'function') {
        return await intuitionEndpoint({
          db: ctx.db,
          embedder: ctx.embedder.wrap,
          detector: ctx.detector,
          query: body.query ?? '',
          sessionId: body.session_id ?? body.sessionId ?? null,
          priorAssistant: body.prior_assistant ?? body.priorAssistant ?? '',
          k: body.k ?? 6,
          recencyDays: body.recency_days ?? body.recencyDays ?? 30,
          tokenBudget: body.token_budget ?? body.tokenBudget ?? 1500,
        }).catch(() => ({ block: '', hits: 0, tokens: 0, latency_ms: 0 }));
      }
      return { block: '', hits: 0, tokens: 0, latency_ms: 0 };
    },
  },
];
