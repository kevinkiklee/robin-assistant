import { recordPrediction } from '../../jobs/predictions.js';

export function createPredictTool({ db }) {
  return {
    name: 'predict',
    description:
      'Record a falsifiable claim about the future or a verifiable fact. Use when you say "this will take ~30 min" or "you usually prefer X" — anything the user (or you) can later check.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', minLength: 1 },
        kind: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        expected_resolution_at: { type: 'string', description: 'ISO 8601 datetime string' },
      },
      required: ['statement', 'kind', 'confidence'],
    },
    handler: async (args) => {
      const { statement, kind, confidence, expected_resolution_at } = args ?? {};

      if (statement == null || kind == null || confidence == null) {
        return { ok: false, reason: 'missing_arg' };
      }

      if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
        return { ok: false, reason: 'invalid_confidence' };
      }

      const { id } = await recordPrediction(db, {
        statement,
        kind,
        confidence,
        expected_resolution_at,
      });

      return { ok: true, id };
    },
  };
}
