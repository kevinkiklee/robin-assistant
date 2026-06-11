import { closeDb, openDb } from '../../brain/memory/db.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { ackAlert, listAlerts } from '../../kernel/runtime/alert-store.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export function listAlertsText(db: RobinDb, opts: { all?: boolean }): string {
  const rows = listAlerts(db, { all: opts.all, includeAcked: opts.all });
  if (rows.length === 0) return opts.all ? 'No alerts on record.' : 'No open alerts.';
  return rows
    .map((a) => {
      // sqlite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' (UTC, no zone suffix).
      // Only append 'Z' when no zone info is already present.
      const ts =
        a.first_seen_at.endsWith('Z') || a.first_seen_at.includes('+')
          ? a.first_seen_at
          : `${a.first_seen_at}Z`;
      const ageH = Math.round((Date.now() - Date.parse(ts)) / 3_600_000);
      const state = a.resolved_at ? 'resolved' : a.acked_at ? 'acked' : 'open';
      return `#${a.id} [${a.severity}] ${a.key} — ${a.message} (${state}, first seen ${ageH}h ago, fired ${a.fire_count}×)`;
    })
    .join('\n');
}

export function runAck(db: RobinDb, id: number): string {
  return ackAlert(db, id) ? `Acked alert #${id}.` : `No open alert #${id}.`;
}

export async function runAlertsCommand(args: string[]): Promise<void> {
  if (args[0] === 'ack') {
    const idArg = args[1];
    const id = idArg ? Number(idArg) : NaN;
    if (!Number.isInteger(id)) {
      console.error('usage: robin alerts ack <id>');
      process.exit(2);
    }
    const userData = resolveUserDataDir();
    const db = openDb(dbFilePath(userData));
    applyMigrations(db, allMigrations);
    try {
      console.log(runAck(db, id));
    } finally {
      closeDb(db);
    }
  } else {
    const all = args.includes('--all');
    const userData = resolveUserDataDir();
    const db = openDb(dbFilePath(userData));
    applyMigrations(db, allMigrations);
    try {
      console.log(listAlertsText(db, { all }));
    } finally {
      closeDb(db);
    }
  }
}
