import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RobinDb } from '../../brain/memory/db.ts';
import { createLogger } from '../logging/logger.ts';

/**
 * Rebuild the Kuzu graph projection from v3's SQLite entities + relations tables.
 * Drops + recreates the Kuzu file (single-file mode).
 *
 * Returns counts: { entities, relations, durationMs }.
 */
export async function rebuildKuzuProjection(
  sqliteDb: RobinDb,
  kuzuPath: string,
): Promise<{ entities: number; relations: number; durationMs: number }> {
  const log = createLogger({ module: 'kuzu-projection' });
  const start = Date.now();
  mkdirSync(dirname(kuzuPath), { recursive: true });

  // Drop existing projection (rebuild-from-scratch is simpler than incremental for MVP)
  if (existsSync(kuzuPath)) {
    rmSync(kuzuPath, { recursive: true, force: true });
  }

  // Dynamic import — kuzu is heavy
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kuzu: any;
  try {
    // biome-ignore lint/security/noDynamicImport: Heavy module loaded on-demand
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,global-require,@typescript-eslint/ban-ts-comment
    // @ts-expect-error kuzu not in devDependencies; loaded on-demand
    kuzu = await import('kuzu');
  } catch (err) {
    log.warn({ err }, 'kuzu module not loadable; skipping projection rebuild');
    return { entities: 0, relations: 0, durationMs: Date.now() - start };
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const db = new kuzu.Database(kuzuPath);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const conn = new kuzu.Connection(db);

  try {
    // Schema
    await conn.query('CREATE NODE TABLE Entity(id INT64 PRIMARY KEY, type STRING, canonical_name STRING)');
    await conn.query('CREATE REL TABLE Relation(FROM Entity TO Entity, predicate STRING, ts STRING)');

    // Copy entities
    const entityRows = sqliteDb.prepare('SELECT id, type, canonical_name FROM entities').all() as Array<{
      id: number;
      type: string;
      canonical_name: string;
    }>;
    for (const e of entityRows) {
      // Escape single quotes in strings
      const ename = e.canonical_name.replace(/'/g, "\\'");
      const etype = e.type.replace(/'/g, "\\'");
      // biome-ignore lint/security/noImplicitInject: Escaping single quotes; input from trusted internal schema
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await conn.query(
        `CREATE (e:Entity {id: ${e.id}, type: '${etype}', canonical_name: '${ename}'})`,
      );
    }

    // Copy relations
    const relRows = sqliteDb
      .prepare('SELECT subject_id, object_id, predicate, ts FROM relations')
      .all() as Array<{
      subject_id: number;
      object_id: number;
      predicate: string;
      ts: string;
    }>;
    for (const r of relRows) {
      const pred = r.predicate.replace(/'/g, "\\'");
      const ts = (r.ts ?? '').replace(/'/g, "\\'");
      // biome-ignore lint/security/noImplicitInject: Escaping single quotes; input from trusted internal schema
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await conn.query(
        `MATCH (a:Entity {id: ${r.subject_id}}), (b:Entity {id: ${r.object_id}}) CREATE (a)-[:Relation {predicate: '${pred}', ts: '${ts}'}]->(b)`,
      );
    }

    return { entities: entityRows.length, relations: relRows.length, durationMs: Date.now() - start };
  } finally {
    // kuzu has no explicit close; let GC handle
  }
}

/**
 * Run a Cypher query against the existing Kuzu projection. Returns the result rows.
 * Caller is responsible for query correctness; this is a thin pass-through.
 */
export async function queryKuzu<T = Record<string, unknown>>(
  kuzuPath: string,
  cypher: string,
): Promise<T[]> {
  if (!existsSync(kuzuPath)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kuzu: any;
  try {
    // biome-ignore lint/security/noDynamicImport: Heavy module loaded on-demand
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,global-require,@typescript-eslint/ban-ts-comment
    // @ts-expect-error kuzu not in devDependencies; loaded on-demand
    kuzu = await import('kuzu');
  } catch {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const db = new kuzu.Database(kuzuPath);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const conn = new kuzu.Connection(db);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const result = await conn.query(cypher);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  return (await result.getAll()) as T[];
}
