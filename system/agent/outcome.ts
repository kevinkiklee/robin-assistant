import { z } from 'zod';

/**
 * Common structured-outcome envelope every handler (A–L) requests via the SDK's
 * `outputFormat` (spec §B1). The same run is forced to summarize structurally at
 * the end — no extra LLM call. `additionalProperties: true` lets handlers extend
 * the envelope with handler-specific fields without schema churn.
 */
export const OUTCOME_ENVELOPE_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['did-work', 'no-op', 'blocked'] },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { type: { type: 'string' }, summary: { type: 'string' } },
          required: ['type', 'summary'],
          additionalProperties: false,
        },
      },
      impact: { type: 'string', enum: ['high', 'medium', 'low'] },
      notes: { type: 'string' },
    },
    required: ['outcome', 'impact'],
    additionalProperties: true,
  },
} as const;

// z.looseObject = tolerate unknown keys (handler-specific extensions).
const envelopeSchema = z.looseObject({
  outcome: z.enum(['did-work', 'no-op', 'blocked']),
  changes: z.array(z.object({ type: z.string(), summary: z.string() })).optional(),
  impact: z.enum(['high', 'medium', 'low']),
  notes: z.string().optional(),
});

export type OutcomeEnvelope = z.infer<typeof envelopeSchema>;

/** Validate a run's `result.structured` into an envelope; null on any mismatch (never throws). */
export function parseOutcomeEnvelope(structured: unknown): OutcomeEnvelope | null {
  const r = envelopeSchema.safeParse(structured);
  return r.success ? r.data : null;
}
