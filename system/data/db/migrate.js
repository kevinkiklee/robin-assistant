import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { surql } from 'surrealdb';
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

    // Apply: the file body in a transaction.
    const tx = `BEGIN TRANSACTION;\n${sql}\n;\nCOMMIT TRANSACTION;`;
    await db.query(tx).collect();
    // Insert the tracking row using the parameterised tagged template.
    const name = basename(file);
    await db
      .query(
        surql`CREATE _migrations SET version = ${version}, name = ${name}, checksum = ${checksum};`,
      )
      .collect();
    newlyApplied.push(version);
  }
  return newlyApplied;
}
