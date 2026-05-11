import { resolvePrediction } from '../../jobs/predictions.js';

export function createResolvePredictionTool({ db }) {
  return {
    name: 'resolve_prediction',
    description:
      'Record the outcome of a previously-made prediction. Call when the future arrives or the fact gets verified.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        correct: { type: 'boolean' },
        actual_outcome: { type: 'string' },
      },
      required: ['id', 'correct'],
    },
    handler: async (args) => {
      const { id, correct, actual_outcome } = args;

      if (!id || typeof id !== 'string') {
        return { ok: false, reason: 'id must be a non-empty string' };
      }
      if (typeof correct !== 'boolean') {
        return { ok: false, reason: 'correct must be a boolean' };
      }

      return resolvePrediction(db, { id, correct, actual_outcome });
    },
  };
}
