import {
  type EntityHygieneReport,
  runEntityHygiene,
} from '../../brain/cognition/entity-hygiene.ts';
import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

/** Build a dispatcher the same way the MCP core deps do — lenient, null on failure. */
function buildLlm(userData: string): LLMDispatcher | null {
  try {
    return buildDispatcherFromConfig(loadModels(userData), { lenient: true });
  } catch {
    return null;
  }
}

/* biome-ignore-start lint/suspicious/noConsole: CLI output */
function printProposals(r: EntityHygieneReport, apply: boolean): void {
  for (const p of r.proposals) {
    console.log(`\n[${p.cls}] ${p.members.map((m) => `${m.name} (#${m.id})`).join(' | ')}`);
    if (p.clusters.length === 0) continue;
    for (const c of p.clusters) {
      const verb = c.applied ? 'MERGED' : apply ? 'skipped (merge cap)' : 'would merge';
      console.log(
        `  ${verb} → "${c.canonical}" keep #${c.keep.id} ${c.keep.type}:${c.keep.name} ← ${c.drops
          .map((d) => `${d.type}:${d.name} (#${d.id})`)
          .join(', ')}`,
      );
    }
  }
}

/**
 * `robin entities hygiene [--apply] [--backlog] [--nominate-only]` — merge
 * entities that are the same real-world thing under different names (lexical
 * nomination, LLM judge; see entity-hygiene.ts). Dry run by default: the judge
 * runs and proposed merges print, nothing is written. `--apply` merges, records
 * aliases and verdicts. `--backlog` judges every nominated group (dry run: one
 * pass; with --apply: rounds until a round makes no progress). `--nominate-only`
 * skips the judge and prints candidate groups (no LLM, no writes).
 */
export async function runEntitiesHygieneCmd(
  opts: { apply?: boolean; backlog?: boolean; nominateOnly?: boolean; limit?: number } = {},
): Promise<void> {
  const apply = opts.apply === true;
  const userData = resolveUserDataDir();
  const db: RobinDb = openDb(dbFilePath(userData));
  try {
    if (apply) applyMigrations(db, allMigrations);
    const llm = opts.nominateOnly ? null : buildLlm(userData);
    if (!opts.nominateOnly && !llm) {
      throw new Error('entities hygiene needs an LLM (models.yaml classify role)');
    }
    const total = { judged: 0, merged: 0, removed: 0, aliases: 0 };
    let first: EntityHygieneReport | null = null;
    if (!opts.backlog || !apply) {
      const r = await runEntityHygiene(db, llm, {
        apply,
        nominateOnly: opts.nominateOnly,
        ...(opts.backlog ? { maxGroups: Number.POSITIVE_INFINITY } : {}),
        ...(opts.limit ? { maxGroups: opts.limit } : {}),
      });
      first = r;
      printProposals(r, apply);
      total.judged += r.groupsJudged;
      total.merged += apply ? r.merged : r.clustersProposed;
      total.removed += r.entitiesRemoved;
      total.aliases += r.aliasesAdded;
    } else {
      for (let round = 0; round < 200; round++) {
        const r = await runEntityHygiene(db, llm, {
          apply: true,
          maxGroups: 24,
          maxMerges: 200,
        });
        first ??= r;
        printProposals(r, apply);
        total.judged += r.groupsJudged;
        total.merged += r.merged;
        total.removed += r.entitiesRemoved;
        total.aliases += r.aliasesAdded;
        console.log(
          `  round ${round + 1}: ${r.groupsNominated} groups left, judged ${r.groupsJudged}, merged ${r.merged}`,
        );
        if (r.groupsJudged === 0 || r.recordedJudged === 0) break;
      }
    }
    if (first) {
      console.log(
        `\nEntity hygiene: ${first.entities} entities, ${first.pairsNominated} pairs → ${first.groupsNominated} candidate groups.`,
      );
    }
    if (opts.nominateOnly) {
      console.log('NOMINATE ONLY — no judge, nothing changed.');
      return;
    }
    console.log(
      `Judged ${total.judged} groups — ${apply ? 'merged' : 'would merge'} ${total.merged} clusters` +
        (apply ? ` (${total.removed} entities removed, ${total.aliases} aliases added).` : '.'),
    );
    if (!apply) console.log('DRY RUN — nothing changed. Re-run with --apply to execute.');
  } finally {
    closeDb(db);
  }
}
/* biome-ignore-end lint/suspicious/noConsole: CLI output */
