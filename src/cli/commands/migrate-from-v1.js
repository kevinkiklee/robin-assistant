import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { runMigrations } from '../../db/migrate.js';
import { createEmbedder } from '../../embed/factory.js';
import { exportMappings } from '../../migrate-v1/export-mappings.js';
import { listFailures } from '../../migrate-v1/failures.js';
import { runMigration } from '../../migrate-v1/index.js';
import { buildPlan, renderPlan } from '../../migrate-v1/plan.js';
import { runReset } from '../../migrate-v1/reset.js';
import { printStatus } from '../../migrate-v1/status.js';
import { openV1 } from '../../migrate-v1/v1-client.js';
import { ensureHome, paths } from '../../runtime/home.js';

export function parseArgs(argv) {
  let mode = 'migrate';
  let source = null;
  let dryRun = false;
  let phase = null;
  let exportPath = null;
  let maxBatches = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') {
      source = argv[++i];
    } else if (a.startsWith('--source=')) {
      source = a.slice(9);
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--resume') {
      /* default */
    } else if (a === '--phase') {
      phase = argv[++i];
    } else if (a.startsWith('--phase=')) {
      phase = a.slice(8);
    } else if (a === '--max-batches') {
      maxBatches = Number(argv[++i]);
    } else if (a === '--status') {
      mode = 'status';
    } else if (a === '--show-failures') {
      mode = 'show-failures';
    } else if (a === '--reset') {
      mode = 'reset';
    } else if (a === '--export-mappings') {
      mode = 'export-mappings';
      exportPath = argv[++i];
    } else if (a.startsWith('--export-mappings=')) {
      mode = 'export-mappings';
      exportPath = a.slice(18);
    }
  }
  return { mode, source, dryRun, phase, maxBatches, exportPath };
}

async function checkPreconditions({ source = null, allowMissingV1 = false } = {}) {
  await ensureHome();
  const p = paths();
  const ds = await readDaemonState(p.daemonState);
  if (ds && isPidAlive(ds.pid)) {
    console.error('v2 daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  if (!allowMissingV1) {
    if (!source) {
      console.error('--source <v1-package-root> is required');
      process.exit(1);
    }
    if (!existsSync(source)) {
      console.error(`v1 source path missing: ${source}`);
      process.exit(1);
    }
    const v1Data = source.endsWith('/data') ? source : join(source, 'user-data/runtime/db/data');
    if (!existsSync(v1Data)) {
      console.error(`v1 rocksdb dir missing: ${v1Data}`);
      process.exit(1);
    }
  }
  return p;
}

async function openV2() {
  const p = paths();
  const release = await acquire(p.daemonLock);
  const db = await connect({ engine: `rocksdb://${p.db}` });
  await runMigrations(db, p.migrationsDir);
  return { db, release };
}

export async function migrateFromV1(argv) {
  const args = parseArgs(argv);

  if (args.mode === 'status') {
    await checkPreconditions({ allowMissingV1: true });
    const { db, release } = await openV2();
    try {
      await printStatus(db, console.log);
    } finally {
      await close(db);
      await release();
    }
    return;
  }

  if (args.mode === 'show-failures') {
    await checkPreconditions({ allowMissingV1: true });
    const { db, release } = await openV2();
    try {
      const list = await listFailures(db, { phase: args.phase });
      console.log(`failures: ${list.length}${args.phase ? ` (phase=${args.phase})` : ''}`);
      for (const f of list) {
        console.log(
          `  ${f.occurred_at}  ${f.phase ?? f.v1_table}  ${f.v1_id}  —  ${f.error_message}`,
        );
      }
    } finally {
      await close(db);
      await release();
    }
    return;
  }

  if (args.mode === 'export-mappings') {
    if (!args.exportPath) {
      console.error('--export-mappings requires a path');
      process.exit(1);
    }
    await checkPreconditions({ allowMissingV1: true });
    const { db, release } = await openV2();
    try {
      await exportMappings(db, args.exportPath);
      console.log(`mappings written to ${args.exportPath}`);
    } finally {
      await close(db);
      await release();
    }
    return;
  }

  if (args.mode === 'reset') {
    await checkPreconditions({ allowMissingV1: true });
    const { db, release } = await openV2();
    try {
      await runReset(db, { phase: args.phase, dryRun: args.dryRun, prompt: !args.dryRun });
    } finally {
      await close(db);
      await release();
    }
    return;
  }

  // mode === 'migrate'
  await checkPreconditions({ source: args.source });
  const { db, release } = await openV2();
  try {
    if (args.dryRun) {
      const v1 = await openV1(args.source);
      try {
        const plan = await buildPlan({ v1, v2db: db });
        console.log(renderPlan(plan));
      } finally {
        await v1.close();
      }
      return;
    }

    const embedder = await createEmbedder();
    const result = await runMigration({
      sourcePath: args.source,
      v2db: db,
      embedder,
      log: console.log,
      only: args.phase,
    });
    let totalImported = 0;
    let totalDup = 0;
    for (const [ph, r] of Object.entries(result.phases ?? {})) {
      const imp = r.imported ?? 0;
      const dup = r.dup ?? 0;
      totalImported += imp;
      totalDup += dup;
      console.log(`  ${ph}: imported ${imp}, dup ${dup}`);
    }
    console.log(`✓ migration complete  imported ${totalImported}  dup ${totalDup}`);
  } finally {
    await close(db);
    await release();
  }
}
