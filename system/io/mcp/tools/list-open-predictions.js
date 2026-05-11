import { listOpenPredictions } from '../../../cognition/jobs/predictions.js';

export function createListOpenPredictionsTool({ db }) {
  return {
    name: 'list_open_predictions',
    description:
      "List predictions you made that haven't been resolved yet. Useful when you want to follow up on past claims.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        older_than_days: { type: 'integer', minimum: 1 },
      },
    },
    handler: async (input) => {
      const rows = await listOpenPredictions(db, input ?? {});
      const predictions = rows.map((r) => ({
        id: String(r.id),
        statement: r.statement,
        kind: r.kind,
        confidence: r.confidence,
        predicted_at: r.predicted_at,
        expected_resolution_at: r.expected_resolution_at ?? null,
      }));
      return { predictions };
    },
  };
}
