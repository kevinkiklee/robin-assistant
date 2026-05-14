import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BoundQuery } from 'surrealdb';
import { readConfig } from '../../config/paths.js';
import { sha256 } from '../embed/hash.js';

async function migrationsTableExists(db) {
  const [info] = await db.query('INFO FOR DB').collect();
  const tables = info?.tables ?? {};
  return Object.hasOwn(tables, '_migrations');
}

async function loadApplied(db) {
  if (!(await migrationsTableExists(db))) return new Map();
  const [rows] = await db.query('SELECT version, checksum FROM _migrations').collect();
  const map = new Map();
  for (const r of rows) map.set(r.version, r.checksum);
  return map;
}

function parseVersion(filename) {
  const m = filename.match(/^(\d+)-/);
  if (!m) throw new Error(`migration filename has no leading version digits: ${filename}`);
  return Number.parseInt(m[1], 10);
}

export async function runMigrations(db, migrationsDir) {
  const cfg = await readConfig();
  if (!cfg?.embedder_profile) {
    throw new Error(
      'cannot run migrations: no embedder profile configured. Run `robin install` first.',
    );
  }
  const activeEmbeddingsFile = `0002-embeddings-${cfg.embedder_profile}.surql`;

  const all = (await readdir(migrationsDir)).filter((f) => f.endsWith('.surql')).sort();
  const applied = await loadApplied(db);
  const newlyApplied = [];

  for (const file of all) {
    // 0002-embeddings-<profile>.surql migrations are profile-specific. Apply only the
    // file matching the active profile; skip the others.
    if (file.startsWith('0002-embeddings-') && file !== activeEmbeddingsFile) {
      continue;
    }
    const version = parseVersion(file);
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const checksum = sha256(sql);
    const priorChecksum = applied.get(version);

    if (priorChecksum !== undefined) {
      if (priorChecksum !== checksum) {
        throw new Error(
          `checksum mismatch for migration ${file} (version ${version}): db has ${priorChecksum}, file is ${checksum}. Already-applied migrations must not be edited; create a new migration instead.`,
        );
      }
      continue;
    }

    // Apply: the migration body AND the tracking-row insert in one transaction.
    // Keeping the tracking insert outside the TX risked a state where the
    // migration ran but the `_migrations` row never landed (e.g. process
    // killed between the two queries); the next run would then re-apply the
    // migration. Folding the CREATE into the same TX makes the pair atomic.
    const name = basename(file);
    const tx = `BEGIN TRANSACTION;\n${sql}\n;\nCREATE _migrations SET version = $version, name = $name, checksum = $checksum;\nCOMMIT TRANSACTION;`;
    await db.query(new BoundQuery(tx, { version, name, checksum })).collect();
    newlyApplied.push(version);
  }
  return newlyApplied;
}
