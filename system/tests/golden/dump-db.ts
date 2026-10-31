import type { RobinDb } from '../../brain/memory/db.ts';

/**
 * Full deterministic dump of every ordinary table. Skips SQLite internals,
 * the migration ledger, virtual tables and their shadow tables (FTS, vec):
 * those are derived from base tables already in the dump.
 */
export function dumpDb(db: RobinDb): Record<string, unknown[]> {
  const tables = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as { name: string; sql: string | null }[];
  const virtual = tables.filter((t) => t.sql?.startsWith('CREATE VIRTUAL')).map((t) => t.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    if (t.name.startsWith('sqlite_') || t.name === '_migrations') continue;
    if (virtual.includes(t.name) || virtual.some((v) => t.name.startsWith(`${v}_`))) continue;
    const withoutRowid = /WITHOUT ROWID/i.test(t.sql ?? '');
    out[t.name] = db
      .prepare(`SELECT * FROM "${t.name}" ORDER BY ${withoutRowid ? '1' : 'rowid'}`)
      .all()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row as Record<string, unknown>).map(([k, v]) => [
            k,
            Buffer.isBuffer(v) ? `<blob ${v.length}B>` : v,
          ]),
        ),
      );
  }
  return out;
}
