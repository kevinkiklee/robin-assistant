import type { RobinDb } from '../db.ts';

export interface Migration {
  version: number; // monotonic, e.g. 1, 2, 3
  name: string; // human-readable, kebab-case
  up: (db: RobinDb) => void; // synchronous; called inside a transaction
}
