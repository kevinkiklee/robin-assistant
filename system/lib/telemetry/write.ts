import type { RobinDb } from '../../brain/memory/db.ts';
import { type EventKind, type EventPayload, eventKindSchemas } from './kinds.ts';

export interface WriteOpts {
  source: string;
  actor?: string;
  duration_ms?: number;
  status?: 'ok' | 'error' | 'skipped';
}

export function writeTelemetry<K extends EventKind>(
  db: RobinDb,
  kind: K,
  payload: EventPayload<K>,
  opts: WriteOpts,
): number {
  const schema = eventKindSchemas[kind];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Invalid payload for ${kind}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const stmt = db.prepare(`
    INSERT INTO events (ts, kind, source, actor, duration_ms, status, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    new Date().toISOString(),
    kind,
    opts.source,
    opts.actor ?? null,
    opts.duration_ms ?? null,
    opts.status ?? 'ok',
    JSON.stringify(parsed.data),
  );
  return Number(result.lastInsertRowid);
}
