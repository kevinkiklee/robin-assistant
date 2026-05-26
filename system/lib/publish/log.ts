import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LogRow, TelemetryRow } from './types.ts';

export async function appendLogEntry(logPath: string, row: LogRow | TelemetryRow): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(row)}\n`);
}

export interface ReadLogResult {
  entries: LogRow[];
  skipped: number;
}

export async function readLog(logPath: string): Promise<ReadLogResult> {
  let raw: string;
  try {
    raw = await readFile(logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], skipped: 0 };
    throw err;
  }
  const entries: LogRow[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as LogRow);
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

export interface GroupedSlug {
  slug: string;
  count: number;
  lastAction?: string;
  lastTs?: string;
  lastSource?: string | null;
  lastUrl?: string | null;
}

export function groupBySlug(entries: LogRow[]): GroupedSlug[] {
  const map = new Map<string, GroupedSlug>();
  for (const e of entries) {
    const cur = map.get(e.slug) ?? { slug: e.slug, count: 0 };
    cur.count += 1;
    cur.lastAction = e.action;
    cur.lastTs = e.ts;
    cur.lastSource = e.source ?? cur.lastSource ?? null;
    cur.lastUrl = e.url ?? cur.lastUrl ?? null;
    map.set(e.slug, cur);
  }
  return [...map.values()];
}
