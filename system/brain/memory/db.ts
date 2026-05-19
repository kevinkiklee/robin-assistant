import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DB } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type RobinDb = DB;

export function openDb(path: string): RobinDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function closeDb(db: RobinDb): void {
  if (db.open) db.close();
}
