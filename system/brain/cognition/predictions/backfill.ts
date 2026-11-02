import { z } from 'zod';
import type { LLMDispatcher } from '../../llm/dispatcher.ts';
import type { RobinDb } from '../../memory/db.ts';
import { describeRegistry } from './readers.ts';
import { type PredictionSpec, PredictionSpecSchema, validateSpec } from './spec.ts';

/**
 * Propose structured specs for OPEN, spec-less predictions with one batched
 * `classify` call per BATCH_SIZE rows (design 2026-10-03-prediction-specs).
 * Proposals are validated against the metric registry; an invalid or absent
 * proposal is reported, never written. Writing is a separate, explicit step
 * (`applySpecProposals`) — the CLI only calls it under `--apply`.
 */

const BATCH_SIZE = 10;

const ProposalSchema = z.object({
  specs: z.array(
    z.object({
      id: z.number(),
      spec: PredictionSpecSchema.nullable(),
    }),
  ),
});

export interface OpenPrediction {
  id: number;
  claim: string;
  confidence: number;
  deadline: string | null;
  resolution_method: string | null;
}

export interface SpecProposal {
  id: number;
  claim: string;
  deadline: string | null;
  /** Validated spec, or null when the model proposed none / an invalid one. */
  spec: PredictionSpec | null;
  /** Why a proposed spec was rejected (absent when none was proposed). */
  error?: string;
}

function hasSpecColumn(db: RobinDb): boolean {
  const cols = db.prepare(`PRAGMA table_info(predictions)`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === 'spec');
}

/** Open predictions with no spec yet (all open rows on a pre-039 schema). */
export function listOpenSpeclessPredictions(db: RobinDb, limit?: number): OpenPrediction[] {
  const where = hasSpecColumn(db) ? 'outcome IS NULL AND spec IS NULL' : 'outcome IS NULL';
  return db
    .prepare(
      `SELECT id, claim, confidence, deadline, resolution_method FROM predictions
       WHERE ${where} ORDER BY id${limit ? ' LIMIT ?' : ''}`,
    )
    .all(...(limit ? [limit] : [])) as OpenPrediction[];
}

const SYSTEM_PROMPT = [
  "You convert a personal assistant's forecasts into machine-checkable specs evaluated against its own data.",
  'A spec is {"source","metric","op","threshold","at"?,"key"?,"agg"?,"window_days"?}; the claim is TRUE iff <reading> <op> <threshold>.',
  'op is one of > >= < <= == !=. `at` is an ISO date (end of that day) or datetime; omit it to use the deadline.',
  'Series metrics: agg "value" (latest reading as of at, default) or mean/min/max/sum over window_days ending at `at`.',
  '"any night/day >= X" → agg max; "never clears X" / "stays below X" → agg max with <; "never drops below X" → agg min.',
  'Windowed metrics (~) need window_days and no agg; state metrics (@) take neither. Booleans read 1/0 (e.g. issue_in_backlog == 1).',
  'Return spec null when the claim is not FULLY decided by one metric below (purchases, inbox, critiques of specific frames, named sets, bookings, compound conditions) — a wrong spec is worse than none.',
  'Metrics:',
  describeRegistry(),
  'Return JSON only: {"specs":[{"id":<prediction id>,"spec":{…}|null}, …]} covering every prediction.',
].join('\n');

function parseProposals(
  structured: unknown,
  text: string,
): z.infer<typeof ProposalSchema>['specs'] {
  const direct = ProposalSchema.safeParse(structured);
  if (direct.success) return direct.data.specs;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = ProposalSchema.safeParse(JSON.parse(m[0]));
    return parsed.success ? parsed.data.specs : [];
  } catch {
    return [];
  }
}

export async function proposeSpecs(
  db: RobinDb,
  llm: LLMDispatcher,
  opts: { limit?: number; batchSize?: number } = {},
): Promise<SpecProposal[]> {
  const open = listOpenSpeclessPredictions(db, opts.limit);
  const size = opts.batchSize ?? BATCH_SIZE;
  const out: SpecProposal[] = [];
  for (let i = 0; i < open.length; i += size) {
    const batch = open.slice(i, i + size);
    const lines = batch
      .map(
        (p) =>
          `#${p.id} deadline=${p.deadline ?? 'none'}\n  claim: ${p.claim}` +
          (p.resolution_method ? `\n  method: ${p.resolution_method}` : ''),
      )
      .join('\n');
    let proposals: z.infer<typeof ProposalSchema>['specs'] = [];
    try {
      const res = await llm.invoke('classify', {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: lines }],
        outputSchema: ProposalSchema,
        temperature: 0,
        maxTokens: 2048,
      });
      proposals = parseProposals(res.structured, res.text);
    } catch {
      proposals = []; // a failed batch reports every row as no-proposal
    }
    const byId = new Map(proposals.map((p) => [p.id, p.spec]));
    for (const p of batch) {
      const raw = byId.get(p.id) ?? null;
      if (raw === null) {
        out.push({ id: p.id, claim: p.claim, deadline: p.deadline, spec: null });
        continue;
      }
      const v = validateSpec(raw, p.deadline);
      out.push(
        v.ok
          ? { id: p.id, claim: p.claim, deadline: p.deadline, spec: v.spec }
          : { id: p.id, claim: p.claim, deadline: p.deadline, spec: null, error: v.error },
      );
    }
  }
  return out;
}

/** Write validated proposals onto still-open, still-spec-less rows. Returns rows written. */
export function applySpecProposals(db: RobinDb, proposals: SpecProposal[]): number {
  const stmt = db.prepare(
    `UPDATE predictions SET spec = ? WHERE id = ? AND outcome IS NULL AND spec IS NULL`,
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const p of proposals) {
      if (!p.spec) continue;
      n += stmt.run(JSON.stringify(p.spec), p.id).changes;
    }
  });
  tx();
  return n;
}
