// system/scripts/migrate-rebaseline-checksums.js
//
// One-shot rebaseline for `_migrations` checksums. Use when an
// already-applied migration's body has been edited in a *semantically
// inert* way (comment/whitespace) — the file's hash drifts but the
// schema state is unchanged, so the next `runMigrations` boot would
// throw `checksum mismatch for migration N` and refuse to apply any
// subsequent migration.
//
// Also handles the case where a migration was applied out-of-band via
// the SurrealDB HTTP /sql endpoint (e.g. while the daemon was down) and
// never landed a `_migrations` row — this script will UPSERT the missing
// rows so the runner doesn't try to re-apply them.
//
// Idempotent. Read-only when nothing needs repair.
//
// Usage:
//   node system/scripts/migrate-rebaseline-checksums.js
//   node system/scripts/migrate-rebaseline-checksums.js --dry-run
//   node system/scripts/migrate-rebaseline-checksums.js --versions=12,34,35
//
// The full sweep covers ALL versions present in `_migrations`; the
// `--versions` filter narrows it for cherry-pick repairs.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surql } from 'surrealdb';
import { readConfig } from '../config/paths.js';
import { close, connect } from '../data/db/client.js';
import { sha256 } from '../data/embed/hash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'data', 'db', 'migrations');

function parseFlags(argv) {
  const flags = { dryRun: false, versions: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--versions=')) {
      flags.versions = new Set(
        a
          .slice('--versions='.length)
          .split(',')
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n)),
      );
    }
  }
  return flags;
}

function parseVersion(filename) {
  const m = filename.match(/^(\d+)-/);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

async function readMigrationFiles(profile) {
  const all = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.surql')).sort();
  const activeEmb = `0002-embeddings-${profile}.surql`;
  const files = [];
  for (const f of all) {
    if (f.startsWith('0002-embeddings-') && f !== activeEmb) continue;
    const version = parseVersion(f);
    if (version == null) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    files.push({ version, name: f, checksum: sha256(sql) });
  }
  return files;
}

async function loadApplied(db) {
  const [rows] = await db.query('SELECT version, name, checksum FROM _migrations').collect();
  const m = new Map();
  for (const r of rows ?? []) m.set(r.version, r);
  return m;
}

async function main() {
  const flags = parseFlags(process.argv);
  const cfg = await readConfig();
  if (!cfg?.embedder_profile) {
    console.error('No embedder profile configured — run `robin install` first.');
    process.exit(1);
  }
  const engine = cfg.db?.url ?? 'mem://';
  const db = await connect({ engine, user: cfg.db?.user, pass: cfg.db?.pass });

  try {
    const files = await readMigrationFiles(cfg.embedder_profile);
    const applied = await loadApplied(db);

    const drift = []; // applied row with wrong checksum
    const missing = []; // file applied out-of-band, no row

    for (const f of files) {
      if (flags.versions && !flags.versions.has(f.version)) continue;
      const row = applied.get(f.version);
      if (!row) {
        // Only flag as missing when there's evidence the migration ran —
        // skip silently otherwise (truly-unapplied migrations are runMigrations'
        // job). The "evidence" here is the operator passing --versions
        // explicitly; that gates the backfill behind an explicit ask.
        if (flags.versions) missing.push(f);
        continue;
      }
      if (row.checksum !== f.checksum) drift.push({ file: f, prior: row.checksum });
    }

    if (drift.length === 0 && missing.length === 0) {
      console.log('Nothing to rebaseline. _migrations matches files.');
      return;
    }

    for (const d of drift) {
      console.log(`drift  v${d.file.version}  ${d.file.name}\n  ${d.prior} → ${d.file.checksum}`);
      if (!flags.dryRun) {
        await db
          .query(
            surql`UPDATE _migrations SET checksum = ${d.file.checksum} WHERE version = ${d.file.version}`,
          )
          .collect();
      }
    }
    for (const m of missing) {
      console.log(`backfill  v${m.version}  ${m.name}  (no _migrations row)`);
      if (!flags.dryRun) {
        await db
          .query(
            surql`CREATE _migrations SET version = ${m.version}, name = ${m.name}, checksum = ${m.checksum}`,
          )
          .collect();
      }
    }
    if (flags.dryRun) console.log('(dry run — no writes)');
    else console.log(`Rebaselined: ${drift.length} drift, ${missing.length} backfill.`);
  } finally {
    await close(db);
  }
}

main().catch((e) => {
  console.error('rebaseline failed:', e.message ?? e);
  process.exit(1);
});
