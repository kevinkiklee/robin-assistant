import Database from 'better-sqlite3';
import type { RobinDb } from '../brain/memory/db.ts';

/**
 * Pin a connection's SQLite time functions to a caller-supplied clock. SQLite
 * lets an application-defined function shadow a built-in per connection, and
 * column DEFAULT expressions resolve through the same lookup at insert time, so
 * `DEFAULT (datetime('now'))` follows the pinned clock too. Each call is
 * delegated to a private in-memory connection running the real built-in with
 * 'now' substituted, so every modifier keeps SQLite's exact semantics.
 *
 * Used by the test lab and the golden test. Production never calls it.
 */
const TIME_FNS = ['datetime', 'date', 'time', 'strftime', 'julianday', 'unixepoch'] as const;

function sqliteNow(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
}

type SqlValue = string | number | bigint | Buffer | null;

// One private in-memory connection per process, shared by every pinned connection.
let raw: Database.Database | null = null;
const stmts = new Map<string, Database.Statement>();
function rawDb(): Database.Database {
  raw ??= new Database(':memory:');
  return raw;
}

export function pinSqlClock(db: RobinDb | Database.Database, nowMs: () => number): void {
  for (const fn of TIME_FNS) {
    db.function(fn, { varargs: true, deterministic: false }, (...args: unknown[]): SqlValue => {
      const now = sqliteNow(nowMs());
      // SQLite treats strftime(fmt) as strftime(fmt, 'now'), so a lone format
      // argument needs the sim clock appended explicitly.
      const mapped =
        args.length === 0 && fn !== 'strftime'
          ? [now]
          : fn === 'strftime' && args.length === 1
            ? [args[0], now]
            : args.map((a) => (typeof a === 'string' && a.toLowerCase() === 'now' ? now : a));
      const key = `${fn}/${mapped.length}`;
      let stmt = stmts.get(key);
      if (!stmt) {
        stmt = rawDb().prepare(`SELECT ${fn}(${mapped.map(() => '?').join(',')}) AS v`);
        stmts.set(key, stmt);
      }
      return (stmt.get(...mapped) as { v: SqlValue }).v;
    });
  }
}
