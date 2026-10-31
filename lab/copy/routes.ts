// lab/copy/routes.ts
//
// Which write route produced each belief event: the store cannot tell a direct
// assistant believe() from one that followed a correction, so the copy records it.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export type Route = 'direct-believe' | 'correction-believe';

export interface RouteLedger {
  add(eventId: number, route: Route): void;
  all(): Map<number, Route>;
}

const ROUTES = new Set<string>(['direct-believe', 'correction-believe']);

/** Append-only JSONL; existing lines are re-read on open (one process per sim-day). */
export function openRouteLedger(path: string): RouteLedger {
  const map = new Map<number, Route>();
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { eventId: unknown; route: unknown };
      if (
        typeof row.eventId !== 'number' ||
        typeof row.route !== 'string' ||
        !ROUTES.has(row.route)
      ) {
        throw new Error(`bad route ledger line in ${path}: ${line}`);
      }
      map.set(row.eventId, row.route as Route);
    }
  }
  return {
    add(eventId, route) {
      appendFileSync(path, `${JSON.stringify({ eventId, route })}\n`);
      map.set(eventId, route);
    },
    all: () => new Map(map),
  };
}
