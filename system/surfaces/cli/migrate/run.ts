#!/usr/bin/env node
import { migrateFromV2 } from './from-v2.ts';

async function main() {
  const args = process.argv.slice(2);
  const v2Path = args[0];
  if (!v2Path) {
    console.error('usage: pnpm tsx system/surfaces/cli/migrate/run.ts <v2-path> [--dry-run]');
    process.exit(2);
  }
  const dryRun = args.includes('--dry-run');
  const report = await migrateFromV2({ v2Path, dryRun });
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('migrate failed:', err);
  process.exit(1);
});
