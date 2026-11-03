import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { rebuildVecIndex } from '../../brain/memory/prune-noise.ts';
import { backupDbTo } from '../../surfaces/cli/db.ts';
import { dbFilePath, resolveUserDataDir } from '../paths.ts';

/**
 * Paths (relative to `user-data/`) that never move between the Mac and the VM,
 * in either direction. The DB travels as a separate snapshot file; the role
 * marker, locks and pids are per-machine; the voice corpus stays on the Mac.
 */
export const MOVE_EXCLUDES: readonly string[] = [
  'backups/',
  '**/dem_cache/',
  '**/.venv/',
  'state/chrome-profile/',
  'state/robin.db',
  'state/db/',
  'state/runtime/cloud-role.json',
  'state/runtime/*.lock',
  '**/*.pid',
  'observability/logs/',
  'agent-runs/',
  'content/sources/imessage/',
  'content/sources/corpus/',
  'content/knowledge/imessage-contacts.md',
  'content/knowledge/biography-from-corpus-*.md',
];

/** Event sources whose rows point into Mac-only content; scrubbed from VM snapshots. */
export const MAC_ONLY_EVENT_SOURCES: readonly string[] = ['imessage'];

export type ArgvRunner = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface Remote {
  host: string;
  exec(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  push(localDir: string, remoteDir: string, excludes: readonly string[]): Promise<void>;
  pull(remoteDir: string, localDir: string, excludes: readonly string[]): Promise<void>;
  pushFile(local: string, remote: string): Promise<void>;
  pullFile(remote: string, local: string): Promise<void>;
}

/** Runs argv directly (no shell) and collects its output. A spawn failure reads as code 127. */
export const execArgv: ArgvRunner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/**
 * POSIX single-quote one argument for a remote shell. ssh joins its argv with
 * spaces and hands the string to the remote login shell, so every remote arg
 * goes through this — never interpolate a raw value into the remote command.
 */
export function shq(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

const SSH_OPTS = ['-o', 'BatchMode=yes'];
const withSlash = (p: string) => (p.endsWith('/') ? p : `${p}/`);

/**
 * A Remote over ssh + rsync. Every call is argv (no local shell). rsync is
 * additive: `-a --partial` and never `--delete` — a stale file on the far side
 * is cheaper than a wiped one. Directory transfers get a trailing slash on both
 * sides so they copy the directory's contents, not a nested copy of it.
 */
export function sshRemote(
  host: string,
  run: ArgvRunner = execArgv,
  opts: { rsync?: string } = {},
): Remote {
  // The host lands in ssh/rsync argv: a leading '-' would parse as an option
  // (e.g. -oProxyCommand=…), a ':' or space would change the rsync target.
  if (!/^[A-Za-z0-9_][A-Za-z0-9._@-]*$/.test(host)) throw new Error(`invalid ssh host: ${host}`);
  const rsyncBin = opts.rsync ?? 'rsync';
  const rsync = async (src: string, dst: string, excludes: readonly string[]): Promise<void> => {
    const args = [
      '-a',
      '--partial',
      '--info=progress2',
      '-e',
      `ssh ${SSH_OPTS.join(' ')}`,
      ...excludes.map((p) => `--exclude=${p}`),
      src,
      dst,
    ];
    const r = await run(rsyncBin, args);
    if (r.code !== 0) {
      throw new Error(
        `rsync ${src} → ${dst} failed (exit ${r.code}): ${r.stderr.trim().slice(-2000)}`,
      );
    }
  };
  const at = (p: string) => `${host}:${p}`;
  return {
    host,
    exec: (argv) => run('ssh', [...SSH_OPTS, host, '--', ...argv.map(shq)]),
    push: (localDir, remoteDir, excludes) =>
      rsync(withSlash(localDir), at(withSlash(remoteDir)), excludes),
    pull: (remoteDir, localDir, excludes) =>
      rsync(at(withSlash(remoteDir)), withSlash(localDir), excludes),
    pushFile: (local, remote) => rsync(local, at(remote), []),
    pullFile: (remote, local) => rsync(at(remote), local, []),
  };
}

/** Online SQLite backup of the instance's live DB to `outPath` (which must not exist). */
export function snapshotDb(userData: string, outPath: string): void {
  const src = dbFilePath(userData);
  if (!existsSync(src)) throw new Error(`no database at ${src}`);
  backupDbTo(src, outPath);
}

/**
 * True when `a` and `b` are the same file. Identity is (dev, ino), so a hard
 * link, a symlink or a case variant on a case-insensitive volume all match;
 * the canonical realpath is a second check. A path that doesn't exist is no
 * file at all, so it matches nothing.
 */
function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.dev === sb.dev && sa.ino === sb.ino) return true;
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
}

function requireDb(path: string): void {
  if (!existsSync(path)) throw new Error(`no database at ${path}`);
}

/**
 * Open a snapshot/restore target and take it out of WAL: everything written
 * lands in the main file (and VACUUM skips the WAL copy). Leaving WAL fails
 * while any other connection holds the file, so a held-open file is refused
 * rather than scrubbed into a -wal the shipped .sqlite never sees.
 */
function openRollbackJournal(path: string): RobinDb {
  const db = openDb(path);
  let mode: string;
  try {
    mode = String(db.pragma('journal_mode = DELETE', { simple: true }));
  } catch (err) {
    closeDb(db);
    throw new Error(
      `cannot take ${path} out of WAL (journal_mode): another process holds it open — ${(err as Error).message}`,
    );
  }
  if (mode !== 'delete') {
    closeDb(db);
    throw new Error(`journal_mode stayed ${mode} on ${path}: another process holds it open`);
  }
  return db;
}

/** Close, then assert no side file survived (the main file is the whole DB). */
function closeRollbackJournal(db: RobinDb, path: string): void {
  closeDb(db);
  const left = ['-wal', '-shm', '-journal'].filter((s) => existsSync(path + s));
  if (left.length > 0) throw new Error(`${path} left side files: ${left.join(', ')}`);
}

const sourcesSql = () => MAC_ONLY_EVENT_SOURCES.map(() => '?').join(', ');
const macIdsSql = () => `SELECT id FROM events WHERE source IN (${sourcesSql()})`;

/**
 * Every `[table, column]` whose row is derived from the event its column names:
 * scrubbed with a Mac-only event and restored with it. A guard test fails when a
 * migration adds an event-id column that is neither here nor in
 * {@link EVENT_REFERENCE_EXEMPT}.
 */
export const EVENT_REFERENCING_COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ['relations', 'source_event_id'],
  ['belief_candidates', 'source_event_id'],
  ['recommendations', 'source_event_id'],
  ['biographer_progress', 'source_event_id'],
  ['claim_failures', 'event_id'],
  ['linear_issue_map', 'source_event_id'],
];

/** Event-id columns (`table.column`) that do not make their row derived, and why. */
export const EVENT_REFERENCE_EXEMPT: Readonly<Record<string, string>> = {
  'recommendations.action_event_id':
    'the rec was made elsewhere; the FK (ON DELETE SET NULL) unlinks a Mac-only fulfilling event',
  'habits.evidence_event_ids': 'a JSON list of ids, no event text',
};

/** The derived-row columns that exist in this DB (older schemas lack some tables). */
function refColumns(db: RobinDb): Array<readonly [string, string]> {
  const has = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`);
  return EVENT_REFERENCING_COLUMNS.filter(([t, c]) => has.get(t, c) !== undefined);
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/**
 * Remove Mac-only events from a SNAPSHOT file: rows derived from them
 * ({@link EVENT_REFERENCING_COLUMNS}), the events, the content rows only they
 * reference, those rows' events_vec embeddings and (via the
 * `events_content_ad` trigger, migration 003) their FTS entries. Then the FTS
 * index is rebuilt, events_vec repacked and the file VACUUMed, so the deleted
 * text survives in no freed page, stale FTS segment or vec0 chunk — the file is
 * what crosses to the VM. The file is left in rollback-journal mode with no
 * side files. Refuses the live DB (same dev/inode: symlink, hard link or case
 * variant) and a file another connection holds open.
 */
export function scrubMacOnlyRows(
  dbPath: string,
  opts: { liveDbPath?: string } = {},
): { removed: number; derived: number } {
  const live = opts.liveDbPath ?? dbFilePath(resolveUserDataDir());
  if (sameFile(dbPath, live)) {
    throw new Error(`refusing to scrub the live DB (${dbPath}); scrub a snapshot copy`);
  }
  requireDb(dbPath);
  const db = openRollbackJournal(dbPath);
  let ok = false;
  try {
    const r = scrubRows(db);
    if (r.removed + r.derived > 0) {
      db.exec(`INSERT INTO events_content_fts(events_content_fts) VALUES ('rebuild')`);
      rebuildVecIndex(db);
      db.exec('VACUUM');
    }
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity_check after scrub: ${String(integrity)}`);
    ok = true;
    return r;
  } finally {
    if (ok) closeRollbackJournal(db, dbPath);
    else closeDb(db);
  }
}

function scrubRows(db: RobinDb): { removed: number; derived: number } {
  const sources = [...MAC_ONLY_EVENT_SOURCES];
  return db.transaction(() => {
    let derived = 0;
    for (const [t, c] of refColumns(db)) {
      derived += db
        .prepare(`DELETE FROM ${q(t)} WHERE ${q(c)} IN (${macIdsSql()})`)
        .run(...sources).changes;
    }
    const refs = db
      .prepare(
        `SELECT DISTINCT content_ref AS id FROM events
          WHERE source IN (${sourcesSql()}) AND content_ref IS NOT NULL`,
      )
      .all(...sources) as Array<{ id: number }>;
    const removed = db
      .prepare(`DELETE FROM events WHERE source IN (${sourcesSql()})`)
      .run(...sources).changes;
    // Content still referenced by a surviving event stays (shared rows are rare,
    // but deleting one would null that event's content_ref).
    const stillUsed = db.prepare(`SELECT 1 FROM events WHERE content_ref = ? LIMIT 1`);
    const delContent = db.prepare(`DELETE FROM events_content WHERE id = ?`);
    // vec0 rowid bindings reject JS Number (see prune-noise.ts) — use BigInt.
    const delVec = db.prepare(`DELETE FROM events_vec WHERE rowid = ?`);
    for (const { id } of refs) {
      if (stillUsed.get(id)) continue;
      delContent.run(id); // fires events_content_ad → FTS 'delete'
      delVec.run(BigInt(id));
    }
    return { removed, derived };
  })();
}

interface EventRow {
  id: number;
  ts: string;
  kind: string;
  source: string;
  actor: string | null;
  duration_ms: number | null;
  status: string;
  payload: string;
  content_ref: number | null;
  import_key: string | null;
}

type Row = Record<string, unknown>;

/**
 * Copy Mac-only events, their content and their derived rows from `fromDbPath`
 * (the Mac's own, never-scrubbed DB) into `intoDbPath` (the DB a rollback
 * brought home). Ids are kept when free (`INSERT OR IGNORE`); an id the VM
 * reused for a row of its own is never overwritten — that event, content or
 * derived row gets a fresh id instead, and derived rows follow their event's
 * new id. Idempotent: an event already present (same import_key, or same
 * source, kind, ts and payload) or a derived row already present (same values)
 * is skipped. Embeddings stay NULL for the embedder; the `events_content_ai`
 * trigger indexes the restored text in FTS. A derived row whose other foreign
 * key no longer resolves on this side (e.g. an entity merged away on the VM) is
 * counted in `skipped`, not inserted.
 */
export function restoreMacOnlyRows(
  fromDbPath: string,
  intoDbPath: string,
): { restored: number; derived: number; skipped: number } {
  requireDb(fromDbPath);
  requireDb(intoDbPath);
  if (sameFile(fromDbPath, intoDbPath)) {
    throw new Error('restore source and target are the same DB');
  }
  // The Mac's own DB is only read (openDb, so lab path guards apply; it is WAL already).
  const from = openDb(fromDbPath);
  let rows: Array<EventRow & { body: string | null; content_ts: string | null }>;
  const derivedRows: Array<{ table: string; column: string; rows: Row[] }> = [];
  try {
    rows = from
      .prepare(
        `SELECT e.id, e.ts, e.kind, e.source, e.actor, e.duration_ms, e.status, e.payload,
                e.content_ref, e.import_key, c.body, c.ts AS content_ts
           FROM events e LEFT JOIN events_content c ON c.id = e.content_ref
          WHERE e.source IN (${sourcesSql()})
          ORDER BY e.id`,
      )
      .all(...MAC_ONLY_EVENT_SOURCES) as typeof rows;
    for (const [table, column] of refColumns(from)) {
      const r = from
        .prepare(`SELECT * FROM ${q(table)} WHERE ${q(column)} IN (${macIdsSql()})`)
        .all(...MAC_ONLY_EVENT_SOURCES) as Row[];
      if (r.length > 0) derivedRows.push({ table, column, rows: r });
    }
  } finally {
    closeDb(from);
  }

  const into = openRollbackJournal(intoDbPath);
  let ok = false;
  try {
    const present = into.prepare(
      `SELECT id FROM events
        WHERE (import_key IS NOT NULL AND import_key = @import_key)
           OR (source = @source AND kind = @kind AND ts = @ts AND payload = @payload)
        LIMIT 1`,
    );
    const contentSameId = into.prepare(
      `INSERT OR IGNORE INTO events_content (id, ts, body) VALUES (?, ?, ?)`,
    );
    const contentNewId = into.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`);
    const cols = `ts, kind, source, actor, duration_ms, status, payload, content_ref, import_key`;
    const vals = `@ts, @kind, @source, @actor, @duration_ms, @status, @payload, @content_ref, @import_key`;
    const eventSameId = into.prepare(
      `INSERT OR IGNORE INTO events (id, ${cols}) VALUES (@id, ${vals})`,
    );
    const eventNewId = into.prepare(`INSERT INTO events (${cols}) VALUES (${vals})`);
    const intoRefs = new Set(refColumns(into).map(([t, c]) => `${t}.${c}`));

    const result = into.transaction(() => {
      const contentMap = new Map<number, number>();
      const eventMap = new Map<number, number>();
      let restored = 0;
      for (const row of rows) {
        const existing = present.get(row) as { id: number } | undefined;
        if (existing) {
          eventMap.set(row.id, existing.id);
          continue;
        }
        let contentRef: number | null = null;
        if (row.content_ref !== null && row.body !== null && row.content_ts !== null) {
          const mapped = contentMap.get(row.content_ref);
          if (mapped !== undefined) contentRef = mapped;
          else {
            const same = contentSameId.run(row.content_ref, row.content_ts, row.body);
            contentRef =
              same.changes === 1
                ? row.content_ref
                : Number(contentNewId.run(row.content_ts, row.body).lastInsertRowid);
            contentMap.set(row.content_ref, contentRef);
          }
        }
        const ev = { ...row, content_ref: contentRef };
        const same = eventSameId.run(ev);
        eventMap.set(
          row.id,
          same.changes === 1 ? row.id : Number(eventNewId.run(ev).lastInsertRowid),
        );
        restored++;
      }

      let derived = 0;
      let skipped = 0;
      for (const { table, column, rows: drows } of derivedRows) {
        if (!intoRefs.has(`${table}.${column}`)) {
          skipped += drows.length;
          continue;
        }
        const r = restoreDerived(into, table, column, drows, eventMap);
        derived += r.inserted;
        skipped += r.skipped;
      }
      return { restored, derived, skipped };
    })();
    ok = true;
    return result;
  } finally {
    if (ok) closeRollbackJournal(into, intoDbPath);
    else closeDb(into);
  }
}

/**
 * Insert derived rows of one table with their event column remapped. A table
 * whose primary key is a rowid-alias `id` keeps the id when free and takes a
 * fresh one when the VM reused it. A row already present with the same values
 * is neither inserted nor counted; one blocked by a VM row on another key
 * (`relations.import_key`, `claim_failures(event_id, chunk_idx)`, the keys of
 * `linear_issue_map`/`biographer_progress`) or by a dangling FK is `skipped` —
 * the VM's row wins.
 */
function restoreDerived(
  db: RobinDb,
  table: string,
  column: string,
  rows: Row[],
  eventMap: Map<number, number>,
): { inserted: number; skipped: number } {
  const info = db.prepare(`SELECT name, type, pk FROM pragma_table_info(?)`).all(table) as Array<{
    name: string;
    type: string;
    pk: number;
  }>;
  const pks = info.filter((c) => c.pk > 0);
  const idAlias = pks.length === 1 && pks[0].name === 'id' && /^integer$/i.test(pks[0].type);
  const known = new Set(info.map((c) => c.name));
  const colsOf = (r: Row) => Object.keys(r).filter((k) => known.has(k));
  let inserted = 0;
  let skipped = 0;
  for (const raw of rows) {
    const eventId = eventMap.get(raw[column] as number);
    if (eventId === undefined) {
      skipped++;
      continue;
    }
    const row: Row = { ...raw, [column]: eventId };
    const all = colsOf(row);
    const rest = all.filter((k) => !(idAlias && k === 'id'));
    const insert = (names: string[]) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO ${q(table)} (${names.map(q).join(', ')})
           VALUES (${names.map((n) => `@${n}`).join(', ')})`,
        )
        .run(Object.fromEntries(names.map((n) => [n, row[n]]))).changes;
    try {
      const dup = db
        .prepare(
          `SELECT 1 FROM ${q(table)} WHERE ${rest.map((n) => `${q(n)} IS @${n}`).join(' AND ')} LIMIT 1`,
        )
        .get(Object.fromEntries(rest.map((n) => [n, row[n]])));
      if (dup) continue;
      if (insert(all) === 1 || (idAlias && insert(rest) === 1)) inserted++;
      else skipped++;
    } catch (err) {
      // An FK that no longer resolves here (statement-level; the transaction goes on).
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY') skipped++;
      else throw err;
    }
  }
  return { inserted, skipped };
}
