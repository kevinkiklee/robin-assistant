import { resolvePrediction } from '../../../cognition/jobs/predictions.js';

export const predictionsRoutes = [
  {
    method: 'POST',
    path: '/internal/predictions/resolve',
    async handler({ ctx, body }) {
      return await resolvePrediction(ctx.db, body);
    },
  },
];
