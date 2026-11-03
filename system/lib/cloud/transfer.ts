import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
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

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

const sourcesSql = () => MAC_ONLY_EVENT_SOURCES.map(() => '?').join(', ');

/**
 * Remove Mac-only events from a SNAPSHOT file: the events, the content rows only
 * they reference, those rows' events_vec embeddings and (via the
 * `events_content_ad` trigger, migration 003) their FTS entries. Then the FTS
 * index is rebuilt, events_vec repacked and the file VACUUMed, so the deleted
 * text survives in no freed page, stale FTS segment or vec0 chunk — the file is
 * what crosses to the VM. Refuses the live DB (resolved through symlinks).
 */
export function scrubMacOnlyRows(
  dbPath: string,
  opts: { liveDbPath?: string } = {},
): { removed: number } {
  const live = opts.liveDbPath ?? dbFilePath(resolveUserDataDir());
  if (samePath(dbPath, live)) {
    throw new Error(`refusing to scrub the live DB (${dbPath}); scrub a snapshot copy`);
  }
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const db = openDb(dbPath);
  try {
    const removed = scrubRows(db);
    if (removed > 0) {
      db.exec(`INSERT INTO events_content_fts(events_content_fts) VALUES ('rebuild')`);
      rebuildVecIndex(db);
      db.exec('VACUUM');
    }
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity_check after scrub: ${String(integrity)}`);
    return { removed };
  } finally {
    closeDb(db);
  }
}

function scrubRows(db: RobinDb): number {
  const sources = [...MAC_ONLY_EVENT_SOURCES];
  return db.transaction(() => {
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
    return removed;
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

/**
 * Copy Mac-only events and their content from `fromDbPath` (the Mac's own,
 * never-scrubbed DB) into `intoDbPath` (the DB a rollback brought home). Ids are
 * kept when free (`INSERT OR IGNORE`); an id the VM reused for a row of its own
 * is never overwritten — that event or content row gets a fresh id instead.
 * Idempotent: an event already present (same import_key, or same source, kind,
 * ts and payload) is skipped. Embeddings stay NULL for the embedder; the
 * `events_content_ai` trigger indexes the restored text in FTS.
 */
export function restoreMacOnlyRows(fromDbPath: string, intoDbPath: string): { restored: number } {
  if (samePath(fromDbPath, intoDbPath))
    throw new Error('restore source and target are the same DB');
  const from = openDb(fromDbPath);
  let rows: Array<EventRow & { body: string | null; content_ts: string | null }>;
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
  } finally {
    closeDb(from);
  }

  const into = openDb(intoDbPath);
  try {
    const present = into.prepare(
      `SELECT 1 FROM events
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

    const restored = into.transaction(() => {
      const contentMap = new Map<number, number>();
      let n = 0;
      for (const row of rows) {
        if (present.get(row)) continue;
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
        if (eventSameId.run(ev).changes === 0) eventNewId.run(ev);
        n++;
      }
      return n;
    })();
    return { restored };
  } finally {
    closeDb(into);
  }
}
