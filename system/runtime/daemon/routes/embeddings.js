export const embeddingsRoutes = [
  {
    method: 'POST',
    path: '/internal/embeddings/op',
    async handler({ ctx, body }) {
      // Kept dynamic: embeddings-ops loads SurrealQL fragments and is only
      // exercised through this single route. Cheap on first hit, cached after.
      const { dispatch: dispatchEmbeddingsOp } = await import(
        '../../../cognition/jobs/embeddings-ops.js'
      );
      const result = await dispatchEmbeddingsOp(ctx.db, body);
      if (!result?.ok) {
        return { _status: 400, _body: result };
      }
      return result;
    },
  },
];
