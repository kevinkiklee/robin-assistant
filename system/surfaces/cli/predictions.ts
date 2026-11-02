import {
  applySpecProposals,
  proposeSpecs,
  type SpecProposal,
} from '../../brain/cognition/predictions/backfill.ts';
import { describeSpec, readSpec } from '../../brain/cognition/predictions/resolve-spec.ts';
import {
  parseStoredSpec,
  specAtEndMs,
  validateSpec,
} from '../../brain/cognition/predictions/spec.ts';
import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

/**
 * `robin predictions specs` — open predictions and their structured specs
 * (design docs/design/2026-10-03-prediction-specs.md).
 *
 *   robin predictions specs                      list open spec'd predictions (+ live reading once due)
 *   robin predictions specs --backfill           LLM-propose specs for open spec-less rows (dry run)
 *   robin predictions specs --backfill --apply   …and write the valid ones
 *
 * Without --apply nothing is written and migrations are NOT applied, so the
 * report is safe against the live DB.
 */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function hasSpecColumn(db: RobinDb): boolean {
  const cols = db.prepare(`PRAGMA table_info(predictions)`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === 'spec');
}

/** Open spec'd predictions, with the current reading for any whose `at` has passed. */
export function specsText(db: RobinDb, now: Date = new Date()): string {
  if (!hasSpecColumn(db)) return 'predictions.spec column missing — migration 039 not applied yet.';
  const rows = db
    .prepare(
      `SELECT id, claim, deadline, spec FROM predictions WHERE outcome IS NULL AND spec IS NOT NULL ORDER BY id`,
    )
    .all() as Array<{ id: number; claim: string; deadline: string | null; spec: string }>;
  const open = (
    db.prepare(`SELECT COUNT(*) AS c FROM predictions WHERE outcome IS NULL`).get() as { c: number }
  ).c;
  const lines = [`Open predictions: ${open} (${rows.length} with a spec)`];
  for (const r of rows) {
    const v = validateSpec(parseStoredSpec(r.spec), r.deadline);
    if (!v.ok) {
      lines.push(`  #${r.id} INVALID SPEC (${v.error}) — ${clip(r.claim, 70)}`);
      continue;
    }
    const atEnd = specAtEndMs(v.spec.at ?? r.deadline) as number;
    let status = `due ${new Date(atEnd).toISOString().slice(0, 10)}`;
    if (atEnd < now.getTime()) {
      const reading = readSpec(db, v.spec, v.metric, atEnd);
      status = reading ? `reading ${reading.value} (n=${reading.n})` : 'due, no reading yet';
    }
    lines.push(`  #${r.id} ${describeSpec(v.spec)} — ${status} — ${clip(r.claim, 70)}`);
  }
  return lines.join('\n');
}

export function proposalsText(proposals: SpecProposal[], applied: number | null): string {
  const withSpec = proposals.filter((p) => p.spec);
  const rejected = proposals.filter((p) => !p.spec && p.error);
  const lines = [
    `Spec backfill over ${proposals.length} open spec-less prediction(s): ${withSpec.length} proposed, ${rejected.length} rejected by validation, ${proposals.length - withSpec.length - rejected.length} left without a spec.`,
  ];
  for (const p of withSpec) {
    lines.push(`  #${p.id} ${JSON.stringify(p.spec)}\n      ${clip(p.claim, 110)}`);
  }
  for (const p of rejected) lines.push(`  #${p.id} REJECTED: ${p.error} — ${clip(p.claim, 70)}`);
  lines.push(
    applied === null
      ? 'Dry run — nothing written. Re-run with --apply to store the proposed specs.'
      : `Applied: ${applied} spec(s) written.`,
  );
  return lines.join('\n');
}

export async function runPredictionsCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== 'specs') {
    console.error('usage: robin predictions specs [--backfill [--apply] [--limit=N]]');
    process.exit(2);
  }
  const backfill = argv.includes('--backfill');
  const apply = argv.includes('--apply');
  if (apply && !backfill) {
    console.error('--apply only applies with --backfill');
    process.exit(2);
  }
  const limitArg = argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const limit = limitArg ? Number(limitArg) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error('--limit must be a positive integer');
    process.exit(2);
  }

  const userData = resolveUserDataDir();
  const db = openDb(dbFilePath(userData));
  try {
    if (apply) applyMigrations(db, allMigrations); // dry runs never touch the schema
    if (!backfill) {
      console.log(specsText(db));
      return;
    }
    let llm: ReturnType<typeof buildDispatcherFromConfig> | null = null;
    try {
      llm = buildDispatcherFromConfig(loadModels(userData), { lenient: true });
    } catch {
      llm = null;
    }
    if (!llm) throw new Error('spec backfill needs an LLM (models.yaml classify role)');
    const proposals = await proposeSpecs(db, llm, limit ? { limit } : {});
    const applied = apply ? applySpecProposals(db, proposals) : null;
    console.log(proposalsText(proposals, applied));
  } finally {
    closeDb(db);
  }
}
