import { cpSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Integration, IntegrationContext } from '../../_runtime/types.ts';
import { ingest } from '../../../brain/memory/ingest.ts';

function defaultHistoryPath(): string | null {
  const home = homedir();
  if (platform() === 'darwin') {
    return join(home, 'Library/Application Support/Google/Chrome/Default/History');
  }
  if (platform() === 'linux') {
    return join(home, '.config/google-chrome/Default/History');
  }
  return null;
}

export interface ChromeVisit {
  url: string;
  title: string;
  visit_time: number;
  visit_count: number;
}

/** Copy chrome History to a temp location, query, delete the copy. Returns visits since `sinceMicros`. */
function readVisits(historyPath: string, sinceMicros: number, limit: number): ChromeVisit[] {
  if (!existsSync(historyPath)) return [];
  const tmpDir = mkdtempSync(join(tmpdir(), 'robin-chrome-'));
  const copy = join(tmpDir, 'History');
  cpSync(historyPath, copy);
  // Chrome uses WAL — copy the -wal sidecar too if present
  if (existsSync(`${historyPath}-wal`)) cpSync(`${historyPath}-wal`, `${copy}-wal`);
  if (existsSync(`${historyPath}-shm`)) cpSync(`${historyPath}-shm`, `${copy}-shm`);
  try {
    const db = new Database(copy, { readonly: true, fileMustExist: true });
    // Chrome's visit_time is microseconds since 1601-01-01 (Windows epoch).
    // Convert: chrome_ts = unix_ts_micros + 11644473600000000
    // sinceMicros is unix-epoch microseconds; convert to chrome epoch:
    const chromeSince = sinceMicros + 11644473600_000_000;
    const rows = db.prepare(`
      SELECT urls.url AS url, urls.title AS title, MAX(visits.visit_time) AS visit_time, urls.visit_count AS visit_count
        FROM visits JOIN urls ON urls.id = visits.url
       WHERE visits.visit_time > ?
       GROUP BY urls.id
       ORDER BY visit_time DESC
       LIMIT ?
    `).all(chromeSince, limit) as ChromeVisit[];
    db.close();
    return rows;
  } finally {
    try { unlinkSync(copy); } catch { /* ignore */ }
    try { unlinkSync(`${copy}-wal`); } catch { /* ignore */ }
    try { unlinkSync(`${copy}-shm`); } catch { /* ignore */ }
  }
}

function chromeTimeToIso(chromeTime: number): string {
  // chrome_time micros since 1601-01-01 → unix micros since 1970-01-01
  const unixMicros = chromeTime - 11644473600_000_000;
  return new Date(unixMicros / 1000).toISOString();
}

export const integration: Integration = {
  async tick(ctx) {
    const historyPath = ctx.state.get('history_path') ?? defaultHistoryPath();
    if (!historyPath) return { status: 'skipped', message: 'no Chrome history path for this platform' };

    const since = Number.parseInt(ctx.state.get('last_sync_micros') ?? '0', 10);
    let visits: ChromeVisit[];
    try {
      visits = readVisits(historyPath, since, 20);
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }

    let ingested = 0;
    for (const v of visits) {
      const summary = `[chrome] ${v.title || '(untitled)'}\n${v.url}\nvisited ${chromeTimeToIso(v.visit_time)} (${v.visit_count} total visits)`;
      await ingest(ctx.db, ctx.llm, {
        kind: 'integration.chrome.visit',
        source: 'chrome',
        content: summary,
        payload: { url: v.url, title: v.title, visit_count: v.visit_count, visit_time: chromeTimeToIso(v.visit_time) },
      });
      ingested++;
    }
    if (visits.length > 0) {
      ctx.state.set('last_sync_micros', String(visits[0].visit_time - 11644473600_000_000));
    }
    return { status: 'ok', ingested };
  },

  async health(ctx) {
    const historyPath = ctx.state.get('history_path') ?? defaultHistoryPath();
    if (!historyPath) return { ok: false, message: 'unsupported platform' };
    if (!existsSync(historyPath)) return { ok: false, message: `Chrome history not found at ${historyPath} — is Chrome installed?` };
    return { ok: true, message: `reading ${historyPath}` };
  },
};

export const actions = {
  async recent_visits(params: { limit?: number }, ctx: IntegrationContext): Promise<ChromeVisit[]> {
    const historyPath = ctx.state.get('history_path') ?? defaultHistoryPath();
    if (!historyPath) return [];
    return readVisits(historyPath, 0, params.limit ?? 20);
  },
};
