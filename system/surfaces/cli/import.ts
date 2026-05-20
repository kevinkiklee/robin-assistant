import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type Database from 'better-sqlite3';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export type ImportKind = 'events' | 'entities' | 'edges' | 'corrections' | 'predictions';
export const ALL_KINDS: ImportKind[] = [
  'entities',
  'edges',
  'events',
  'corrections',
  'predictions',
];

export interface ImportOptions {
  dir: string;
  kinds?: ImportKind[];
  limit?: number;
  dryRun?: boolean;
}

export interface ImportReport {
  ts: string;
  dir: string;
  dryRun: boolean;
  files: Record<string, { inserted: number; skipped: number; missing?: boolean }>;
  errors: string[];
}

export async function runImport(opts: ImportOptions): Promise<ImportReport> {
  const kinds = opts.kinds ?? ALL_KINDS;
  const report: ImportReport = {
    ts: new Date().toISOString(),
    dir: opts.dir,
    dryRun: !!opts.dryRun,
    files: {},
    errors: [],
  };

  if (!existsSync(opts.dir)) {
    report.errors.push(`directory not found: ${opts.dir}`);
    return report;
  }

  const db = openDb(dbFilePath(resolveUserDataDir()));
  applyMigrations(db, allMigrations);

  // Entities must land before edges so the subject/object lookup hits. Events last so
  // any future enrichment (kind inference, source classification) has the full graph
  // already in place — though within v3 nothing currently depends on this ordering.
  const order: ImportKind[] = ['entities', 'edges', 'events', 'corrections', 'predictions'];

  // One outer transaction across all files. Dry-run ROLLBACKs at the end, real run COMMITs.
  // This is what makes dry-run faithful: edges can look up entities that the entities pass
  // just wrote (within the tx), even though nothing persists.
  db.exec('BEGIN');
  try {
    for (const kind of order) {
      if (!kinds.includes(kind)) continue;
      const path = join(opts.dir, `${kind}.ndjson`);
      if (!existsSync(path)) {
        report.files[`${kind}.ndjson`] = { inserted: 0, skipped: 0, missing: true };
        continue;
      }
      const result = await importNdjson(db, kind, path, opts);
      report.files[`${kind}.ndjson`] = result;
    }
    db.exec(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    report.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    closeDb(db);
  }

  return report;
}

async function importNdjson(
  db: Database.Database,
  kind: ImportKind,
  path: string,
  opts: ImportOptions,
): Promise<{ inserted: number; skipped: number }> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

  // Edges look up their endpoints in the entities table that the entities pass just
  // populated within this same transaction. Re-deriving from the DB also makes an
  // edges-only retry work after entities already landed in a previous run.
  const entityMap = kind === 'edges' ? buildEntityMapFromDb(db) : null;

  const handler = makeHandler(db, kind, entityMap);
  let inserted = 0;
  let skipped = 0;
  let processed = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    if (opts.limit && processed >= opts.limit) break;
    processed++;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    // Handler INSERTs land inside the outer tx managed by runImport. Dry-run still
    // INSERTs — the rollback at the end of runImport makes the whole pass disappear.
    if (handler(row)) inserted++;
    else skipped++;
  }

  return { inserted, skipped };
}

type Handler = (row: Record<string, unknown>) => boolean;

function makeHandler(
  db: Database.Database,
  kind: ImportKind,
  entityMap: Map<string, number> | null,
): Handler {
  switch (kind) {
    case 'entities': {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO entities (type, canonical_name, profile) VALUES (?, ?, ?)`,
      );
      return (row) => {
        const type = typeof row.type === 'string' ? row.type : null;
        const name =
          typeof row.name === 'string'
            ? row.name
            : typeof row.canonical_name === 'string'
              ? row.canonical_name
              : null;
        if (!type || !name) return false;
        const r = ins.run(type, name, JSON.stringify(row));
        return r.changes > 0;
      };
    }

    case 'edges': {
      if (!entityMap) throw new Error('edges import requires entityMap');
      const ins = db.prepare(
        `INSERT INTO relations (subject_id, predicate, object_id, ts) VALUES (?, ?, ?, ?)`,
      );
      return (row) => {
        // v2 edges can connect events↔entities; v3 relations only connect entities.
        // Filter to entity-entity edges; skip event endpoints with no warning (counted as skipped).
        const subj = asEntityRef(row.in) ?? asEntityRef(row.subject);
        const obj = asEntityRef(row.out) ?? asEntityRef(row.object);
        if (!subj || !obj) return false;
        const sId = entityMap.get(subj);
        const oId = entityMap.get(obj);
        if (!sId || !oId) return false;
        const predicate =
          typeof row.kind === 'string'
            ? row.kind
            : typeof row.predicate === 'string'
              ? row.predicate
              : 'related';
        const ts =
          typeof row.last_seen === 'string'
            ? row.last_seen
            : typeof row.created_at === 'string'
              ? row.created_at
              : new Date().toISOString();
        ins.run(sId, predicate, oId, ts);
        return true;
      };
    }

    case 'events': {
      const insContent = db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`);
      const insEvent = db.prepare(
        `INSERT INTO events (ts, kind, source, status, payload, content_ref) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      return (row) => {
        const ts = typeof row.ts === 'string' ? row.ts : new Date().toISOString();
        const source = typeof row.source === 'string' ? row.source : 'v2-import';
        // Synthesize a v3-style kind from v2's source + host so the firehose stays groupable.
        const host =
          typeof (row.meta as { host?: unknown })?.host === 'string'
            ? (row.meta as { host: string }).host
            : null;
        const kind = host ? `${source}.${host}` : `v2.${source}`;
        const body = typeof row.content === 'string' ? row.content : null;
        let contentRef: number | null = null;
        if (body) {
          const r = insContent.run(ts, body);
          contentRef = Number(r.lastInsertRowid);
        }
        insEvent.run(ts, kind, source, 'imported', JSON.stringify(row), contentRef);
        return true;
      };
    }

    case 'corrections': {
      const ins = db.prepare(
        `INSERT INTO corrections (ts, what, correction, context, applied) VALUES (?, ?, ?, ?, ?)`,
      );
      return (row) => {
        const what = typeof row.what === 'string' ? row.what : null;
        const correction = typeof row.correction === 'string' ? row.correction : null;
        if (!what || !correction) return false;
        const ts = typeof row.ts === 'string' ? row.ts : new Date().toISOString();
        const context = typeof row.context === 'string' ? row.context : null;
        ins.run(ts, what, correction, context, 0);
        return true;
      };
    }

    case 'predictions': {
      const ins = db.prepare(
        `INSERT INTO predictions (claim, confidence, deadline, resolution_method, outcome, resolved_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      return (row) => {
        const claim = typeof row.claim === 'string' ? row.claim : null;
        if (!claim) return false;
        ins.run(
          claim,
          typeof row.confidence === 'number' ? row.confidence : 0.5,
          typeof row.deadline === 'string' ? row.deadline : null,
          typeof row.resolution_method === 'string' ? row.resolution_method : null,
          typeof row.outcome === 'string' ? row.outcome : null,
          typeof row.resolved_at === 'string' ? row.resolved_at : null,
        );
        return true;
      };
    }
  }
}

function asEntityRef(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.startsWith('entities:') ? v : null;
}

// Build v2-id → v3-id by replaying the inserted entities. We round-tripped each v2 row's
// full payload into the `profile` column as JSON, so the v2 id is still recoverable.
function buildEntityMapFromDb(db: Database.Database): Map<string, number> {
  const map = new Map<string, number>();
  const rows = db
    .prepare(`SELECT id, profile FROM entities WHERE profile IS NOT NULL`)
    .all() as Array<{
    id: number;
    profile: string;
  }>;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.profile) as { id?: unknown };
      if (typeof p.id === 'string' && p.id.startsWith('entities:')) {
        map.set(p.id, r.id);
      }
    } catch {
      // skip malformed
    }
  }
  return map;
}

export function printImportHuman(report: ImportReport): void {
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`Import ${report.dryRun ? '(dry-run) ' : ''}from ${report.dir}`);
  for (const [file, r] of Object.entries(report.files)) {
    if (r.missing) {
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.log(`  ${file}: skipped (not present)`);
      continue;
    }
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(`  ${file}: ${r.inserted} inserted, ${r.skipped} skipped`);
  }
  if (report.errors.length > 0) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(`Errors: ${report.errors.join('; ')}`);
  }
}
