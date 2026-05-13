// `robin migrate-user-data` — explicit driver for the v1→v2 layout migration.
//
// Normally the migration runs implicitly via `ensureHome()` on the next CLI
// command (or daemon boot). This command exists for two reasons:
//   1. `--dry-run` — print the planned moves without writing.
//   2. Operators who want to migrate before running any other command can
//      invoke this directly with `--verbose` to inspect each rename.

import { ensureHome, robinHome } from '../../../config/data-store.js';
import { detectLayoutVersion, migrateUserDataLayout } from '../../install/layout-migrator.js';

function usage() {
  console.error('usage: robin migrate-user-data [--dry-run] [--verbose]');
}

export async function migrateUserData(argv = []) {
  let dryRun = false;
  let verbose = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--verbose' || arg === '-v') verbose = true;
    else if (arg === '--help' || arg === '-h') {
      usage();
      return;
    } else {
      console.error(`migrate-user-data: unknown argument: ${arg}`);
      usage();
      process.exit(2);
    }
  }

  const home = robinHome();
  const before = detectLayoutVersion(home);
  if (before === 'v2') {
    console.log('layout: already v2 (no-op)');
    return;
  }
  if (before === 'fresh') {
    console.log('layout: fresh install; nothing to migrate');
    return;
  }

  const log = verbose ? (msg) => console.log(`  ${msg}`) : null;
  console.log(`layout: v1 → v2${dryRun ? ' (dry run)' : ''}`);

  try {
    if (dryRun) {
      const result = await migrateUserDataLayout(home, { dryRun, log });
      console.log(
        result.migrated
          ? 'dry-run complete (no changes)'
          : `no migration ran (reason: ${result.reason})`,
      );
    } else {
      // Run through ensureHome so the v2 dir set is created and the marker
      // is finalized in the same call. ensureHome internally triggers the
      // migrator first; subsequent ensureHome invocations are cheap.
      await ensureHome();
      console.log('migration complete');
    }
  } catch (e) {
    if (e.code === 'LAYOUT_MIGRATOR_DAEMON_RUNNING') {
      console.error(e.message);
      process.exit(1);
    }
    if (e.code === 'LAYOUT_MIGRATOR_BUSY') {
      console.error(e.message);
      process.exit(1);
    }
    if (e.code === 'LAYOUT_MIGRATOR_CONFLICT') {
      console.error(`migration aborted: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}
