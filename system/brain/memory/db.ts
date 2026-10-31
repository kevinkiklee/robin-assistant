import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DB } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type RobinDb = DB;

type Guard = (path: string) => void;
type Init = (db: RobinDb) => void;

const guards: Guard[] = [];
const inits: Init[] = [];

function register<T>(list: T[], fn: T): () => void {
  list.push(fn);
  return () => {
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}

/**
 * Run `fn(path)` at the start of every openDb, before any directory or file is
 * created; throwing aborts the open. Production registers none. The test lab
 * uses it to refuse any path under the live instance.
 */
export function registerDbGuard(fn: Guard): () => void {
  return register(guards, fn);
}

/**
 * Run `fn(db)` on every connection after pragmas. Production registers none.
 * The test lab uses it to pin SQLite time functions to the simulated clock.
 */
export function registerDbInit(fn: Init): () => void {
  return register(inits, fn);
}

export function openDb(path: string): RobinDb {
  for (const g of [...guards]) g(path);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    sqliteVec.load(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    // Auto-checkpoints reset the WAL but never shrink the file, so it sat at
    // its 659 MB high-water mark (10/28). This truncates it after each reset.
    db.pragma(`journal_size_limit = ${64 * 1024 * 1024}`);
    for (const init of [...inits]) init(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function closeDb(db: RobinDb): void {
  if (db.open) db.close();
}
