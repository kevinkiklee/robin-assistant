// lab/copy/heads.ts
//
// Daily head captures (spec §5.4). believe() upserts same-topic writes on one local day
// into a single row (external id `belief:<localDate>:<topic>`, ts rewritten), so the
// final snapshot alone loses a claim that a later write overwrote the same day — e.g. a
// 03:50 promotion replaced by a scripted believe that morning. Each copy-day therefore
// dumps every belief.update row at its end; the scorer unions the captures.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RobinDb } from '../../system/brain/memory/db.ts';

export interface HeadCaptureRow {
  eventId: number;
  topic: string;
  ts: string;
  claim: string;
  retracted: boolean;
  /** The row's `sources` was non-empty when captured (a candidate promotion). */
  sources: boolean;
}

const CAPTURE = /^day-(\d{4,})\.jsonl$/;

export function headsDir(sandboxRoot: string): string {
  return join(sandboxRoot, 'heads');
}

/** Every belief.update row in `db`, in event-id order. */
export function readHeadRows(db: RobinDb): HeadCaptureRow[] {
  const rows = db
    .prepare(
      `SELECT e.id AS eventId, json_extract(e.payload,'$.topic') AS topic, e.ts AS ts,
              c.body AS claim, json_extract(e.payload,'$.retracted') AS retracted,
              json_extract(e.payload,'$.sources') AS sources
         FROM events e LEFT JOIN events_content c ON c.id = e.content_ref
        WHERE e.kind = 'belief.update' AND json_extract(e.payload,'$.topic') IS NOT NULL
        ORDER BY e.id`,
    )
    .all() as {
    eventId: number;
    topic: string;
    ts: string;
    claim: string | null;
    retracted: number | null;
    sources: string | null;
  }[];
  return rows.map((r) => ({
    eventId: r.eventId,
    topic: r.topic,
    ts: r.ts,
    claim: r.claim ?? '',
    retracted: r.retracted === 1,
    sources: hasSources(r.sources),
  }));
}

function hasSources(raw: string | null): boolean {
  try {
    const p = JSON.parse(raw ?? '[]');
    return Array.isArray(p) && p.some((n) => typeof n === 'number');
  } catch {
    return false;
  }
}

/** Write `heads/day-NNNN.jsonl` under the sandbox root. */
export function writeHeadCapture(db: RobinDb, sandboxRoot: string, day: number): string {
  const dir = headsDir(sandboxRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `day-${String(day).padStart(4, '0')}.jsonl`);
  const rows = readHeadRows(db);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return path;
}

/** Every capture under the sandbox root, oldest day first. */
export function readHeadCaptures(sandboxRoot: string): { day: number; rows: HeadCaptureRow[] }[] {
  const dir = headsDir(sandboxRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => ({ f, m: CAPTURE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .map(({ f, m }) => ({
      day: Number(m[1]),
      rows: readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as HeadCaptureRow),
    }))
    .sort((a, b) => a.day - b.day);
}
