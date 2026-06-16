import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { degateCandidates } from '../../brain/memory/degate-candidates.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';

export interface DomainSample {
  counts: Record<string, number>;
  recent: Array<{ id: number; domain: string; topic: string; claim: string }>;
}

/** Spot-audit surface (Phase D metric): the most recent belief candidates grouped
 *  by their personal-domain tag, so a human can eyeball whether dev junk is being
 *  tagged as personal. Deterministic SQL, no LLM. NULL domains count as '(untagged)'. */
export function sampleByDomain(db: RobinDb, limit = 30): DomainSample {
  const rows = db
    .prepare(
      `SELECT id, COALESCE(domain, '(untagged)') AS domain, topic, claim
         FROM belief_candidates
        ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as DomainSample['recent'];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.domain] = (counts[r.domain] ?? 0) + 1;
  return { counts, recent: rows };
}

export async function runMemoryCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'audit-sample') {
    const nArg = args[1] && !args[1].startsWith('-') ? Number(args[1]) : undefined;
    const limit = nArg && Number.isFinite(nArg) && nArg > 0 ? nArg : 30;
    const userData = resolveUserDataDir();
    const db = openDb(dbFilePath(userData));
    applyMigrations(db, allMigrations);
    try {
      const { counts, recent } = sampleByDomain(db, limit);
      const total = recent.length;
      console.log(`Recent ${total} belief candidate(s) by domain (limit=${limit}):\n`);
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      for (const [domain, count] of sorted) {
        console.log(`  ${domain.padEnd(16)} ${count}`);
      }
      console.log('');
      for (const row of recent) {
        console.log(`  #${row.id} [${row.domain}] ${row.topic}: ${row.claim}`);
      }
    } finally {
      closeDb(db);
    }
  } else if (sub === 'degate') {
    const apply = args.includes('--apply');
    const useLlm = args.includes('--llm');
    const userData = resolveUserDataDir();

    let llm: LLMDispatcher | null = null;
    if (useLlm) {
      loadEnvFile(userData);
      try {
        llm = buildDispatcherFromConfig(loadModels(userData));
      } catch (err) {
        console.error(
          `robin memory degate --llm: could not build LLM dispatcher — ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    }

    const db = openDb(dbFilePath(userData));
    applyMigrations(db, allMigrations);
    try {
      const r = await degateCandidates(db, llm, { apply, useLlm });
      const mode = apply ? 'APPLY' : 'dry-run';
      console.log(
        `Degate ${mode} — scanned ${r.scanned}, culled ${r.culled} (deterministic + llm=${r.llmClassified} classified), kept ${r.keptDeterministic}`,
      );
      if (r.samples.length > 0) {
        console.log('');
        for (const s of r.samples) {
          console.log(`  #${s.id} [${s.reason}] ${s.topic}: ${s.claim}`);
        }
      }
      if (!apply) {
        console.log('');
        console.log(
          'Dry-run — no changes written. Re-run with --apply to reject (reversible) the culled candidates; add --llm to also run the LLM domain pass.',
        );
      }
    } finally {
      closeDb(db);
    }
  } else {
    console.error(`Unknown memory subcommand: ${sub ?? '(none)'}`);
    console.error('usage: robin memory audit-sample [N]');
    console.error('       robin memory degate [--apply] [--llm]');
    process.exit(2);
  }
}
