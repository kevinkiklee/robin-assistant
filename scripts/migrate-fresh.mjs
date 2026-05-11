#!/usr/bin/env node
// Migrate-fresh: applies the new v2-redesign schema to a freshly-reset DB.
//
// Workflow:
//   1. Resolve ROBIN_HOME via the data-store resolver.
//   2. Read <robinHome>/config.json; if no embedder_profile, default to mxbai-1024.
//   3. Backup the existing <robinHome>/db/ to <robinHome>/cache/backups/<ts>-pre-redesign.tar.gz.
//   4. Open the DB (rocksdb://<robinHome>/db) and apply migrations.
//   5. Report what landed.
//
// This is what we run after merging the redesign into main. The user's daemon
// is not currently running, so no graceful shutdown is needed; if it were
// running, this script would refuse (the rocksdb engine is single-process).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { connect, close } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { robinHome } from '../src/runtime/data-store.js';

const ROBIN_HOME = robinHome();
const CONFIG_PATH = join(ROBIN_HOME, 'config.json');
const DB_DIR = join(ROBIN_HOME, 'db');
const BACKUP_DIR = join(ROBIN_HOME, 'cache', 'backups');
const MIGRATIONS_DIR = new URL('../src/schema/migrations/', import.meta.url).pathname;

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  console.log(`robin-home: ${ROBIN_HOME}`);

  // Step 1: ensure embedder_profile is set in config.json
  let cfg = {};
  if (existsSync(CONFIG_PATH)) {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  }
  if (!cfg.embedder_profile) {
    cfg.embedder_profile = 'mxbai-1024';
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    chmodSync(CONFIG_PATH, 0o644);
    console.log(`config: embedder_profile=mxbai-1024 (default) written to ${CONFIG_PATH}`);
  } else {
    console.log(`config: embedder_profile=${cfg.embedder_profile}`);
  }

  // Step 2: backup the existing DB (if any)
  if (existsSync(DB_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const backupFile = join(BACKUP_DIR, `${ts()}-pre-redesign.tar.gz`);
    console.log(`backup: ${DB_DIR} → ${backupFile}`);
    execFileSync('tar', ['-czf', backupFile, '-C', dirname(DB_DIR), 'db'], { stdio: 'inherit' });
    console.log('backup: done');
  } else {
    console.log('backup: no existing db/ to back up');
  }

  // Step 3: nuke the DB directory so the new schema applies from scratch
  if (existsSync(DB_DIR)) {
    execFileSync('rm', ['-rf', DB_DIR], { stdio: 'inherit' });
    console.log(`nuke: removed ${DB_DIR}`);
  }
  mkdirSync(DB_DIR, { recursive: true });

  // Step 4: open + apply migrations
  console.log('migrate: connecting to fresh DB');
  const db = await connect({ engine: `rocksdb://${DB_DIR}` });
  try {
    const applied = await runMigrations(db, MIGRATIONS_DIR);
    console.log(`migrate: applied ${applied.length} migrations (versions: ${applied.join(', ')})`);

    // Verify a few invariants
    const [info] = await db.query('INFO FOR DB').collect();
    const tables = Object.keys(info?.tables ?? {});
    console.log(`migrate: ${tables.length} tables present`);
    const expected = [
      'events', 'memos', 'entities', 'episodes', 'edges',
      'persona', 'runtime', 'runtime_sessions', 'runtime_jobs',
      'intuition_telemetry', 'recall_log', 'refusals', 'action_trust',
      'rule_candidates', 'rules', '_migrations',
      `embeddings_${cfg.embedder_profile.replace(/-/g, '_')}_events`,
      `embeddings_${cfg.embedder_profile.replace(/-/g, '_')}_memos`,
      `embeddings_${cfg.embedder_profile.replace(/-/g, '_')}_entities`,
    ];
    const missing = expected.filter((t) => !tables.includes(t));
    if (missing.length > 0) {
      console.error(`migrate: MISSING tables: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log('migrate: all expected tables present');

    // Verify runtime:embedder is set
    const [embRow] = await db.query('SELECT VALUE value FROM runtime:embedder').collect();
    if (!embRow?.[0]?.active_profile) {
      console.error('migrate: runtime:embedder.active_profile not set');
      process.exit(1);
    }
    console.log(`migrate: runtime:embedder.active_profile = ${embRow[0].active_profile}`);
  } finally {
    await close(db);
  }

  console.log('\nmigrate-fresh: DONE');
  process.exit(0);
}

main().catch((err) => {
  console.error('migrate-fresh: FATAL', err);
  process.exit(2);
});
