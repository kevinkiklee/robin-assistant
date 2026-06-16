import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

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
  } else {
    console.error(`Unknown memory subcommand: ${sub ?? '(none)'}`);
    console.error('usage: robin memory audit-sample [N]');
    process.exit(2);
  }
}
