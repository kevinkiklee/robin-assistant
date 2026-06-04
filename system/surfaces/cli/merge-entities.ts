import { readFileSync, writeFileSync } from 'node:fs';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import {
  collectMergeSnapshot,
  type MergeGroupRef,
  type MergePlan,
  mergeEntities,
} from '../../brain/memory/merge.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

// `robin db merge-entities --from=<groups.json> [--apply]`
//
// groups.json is a JSON array of merge groups. Each `keep`/`drops` ref is either
// a numeric entity id or a "<type>:<canonical_name>" string:
//
//   [
//     { "keep": "person:Kevin Lee", "drops": ["person:Kevin K. Lee"] },
//     { "keep": 821, "drops": [1934] }
//   ]
//
// Default is a DRY RUN that prints the full scale and changes nothing. Pass
// --apply to execute; a pre-merge snapshot is written next to the DB first.

function printPlan(plan: MergePlan): void {
  for (const g of plan.groups) {
    const dropList = g.drops.map((d) => `${d.type}:${d.canonical_name} (#${d.id})`).join(', ');
    console.log(`• keep ${g.keep.type}:${g.keep.canonical_name} (#${g.keep.id})`);
    console.log(`    ← ${dropList || '(no drops)'}`);
    console.log(
      `    re-point ${g.relationsRepointed} relations · dedup ${g.relationsDeduped} · drop ${g.selfLoopsRemoved} self-loops`,
    );
  }
  const t = plan.totals;
  console.log(
    `\nTOTALS: ${t.entitiesRemoved} entities removed · ${t.relationsRepointed} relations re-pointed · ${t.relationsDeduped} duplicate edges collapsed · ${t.selfLoopsRemoved} self-loops removed`,
  );
}

export function runMergeEntities(opts: { from: string; apply?: boolean }): void {
  let groups: MergeGroupRef[];
  try {
    const parsed = JSON.parse(readFileSync(opts.from, 'utf8'));
    groups = Array.isArray(parsed) ? parsed : parsed?.groups;
  } catch (e) {
    console.error(`Could not read/parse ${opts.from}: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!Array.isArray(groups) || groups.length === 0) {
    console.error('Merge file must be a non-empty JSON array of { keep, drops } groups.');
    process.exit(2);
  }

  const userData = resolveUserDataDir();
  const dbPath = dbFilePath(userData);
  const db = openDb(dbPath);
  try {
    // Always compute and show the plan first — this is the "scale before executing" gate.
    const preview = mergeEntities(db, groups, { apply: false });
    printPlan(preview);

    if (!opts.apply) {
      console.log('\nDRY RUN — nothing changed. Re-run with --apply to execute.');
      return;
    }

    const snapshotPath = `${dbPath}.merge-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(snapshotPath, JSON.stringify(collectMergeSnapshot(db, groups), null, 2));
    mergeEntities(db, groups, { apply: true });
    console.log(`\n✓ Applied ${preview.totals.entitiesRemoved} entity merges.`);
    console.log(`  Pre-merge snapshot → ${snapshotPath}`);
  } catch (e) {
    console.error(`Merge aborted: ${(e as Error).message}`);
    process.exit(2);
  } finally {
    closeDb(db);
  }
}
