import { dispatch as dispatchEmbeddingsOp } from '../../../cognition/jobs/embeddings-ops.js';

export const embeddingsRoutes = [
  {
    method: 'POST',
    path: '/internal/embeddings/op',
    async handler({ ctx, body }) {
      const result = await dispatchEmbeddingsOp(ctx.db, body);
      if (!result?.ok) {
        return { _status: 400, _body: result };
      }
      return result;
    },
  },
];
