import { closeDb, openDb } from '../../brain/memory/db.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface IntegrationStatusRow {
  name: string;
  last_attempt_at: string | null;
  last_ingest_at: string | null;
  last_ingest_count: number | null;
  consecutive_errors: number;
  recent_ok: number;
  recent_err: number;
  last_error: string | null;
  status: 'ok' | 'silent' | 'erroring' | 'broken' | 'idle';
}

export interface IntegrationsReport {
  ts: string;
  rows: IntegrationStatusRow[];
}

/**
 * Status derivation lives here (not in the CLI render layer) so it's stable across
 * surfaces (CLI table, doctor, future MCP tool). Five buckets:
 *   - broken:   no successful attempts in the recent window AND consecutive_errors > 0
 *               → the integration is trying but failing every time (OAuth dead, etc.)
 *   - erroring: consecutive_errors >= 3
 *   - silent:   has fired but never ingested content
 *   - idle:     never seen — scheduled but no tick has run yet
 *   - ok:       recent success + (recent ingests OR is naturally low-volume)
 */
function deriveStatus(r: Omit<IntegrationStatusRow, 'status'>): IntegrationStatusRow['status'] {
  if (r.recent_ok === 0 && r.recent_err > 0) return 'broken';
  if (r.consecutive_errors >= 3) return 'erroring';
  if (r.last_attempt_at === null) return 'idle';
  if (r.last_ingest_at === null) return 'silent';
  return 'ok';
}

export function runIntegrationsReport(): IntegrationsReport {
  const userData = resolveUserDataDir();
  const db = openDb(dbFilePath(userData));
  try {
    // Collect every integration name we know about — either via integration_state
    // (anything that's ever ticked under the heartbeat code) or via the jobs table
    // (anything currently scheduled). Union catches the "scheduled but never fired
    // yet" idle case without missing it.
    const namesFromState = db
      .prepare(`SELECT DISTINCT integration_name AS name FROM integration_state`)
      .all() as Array<{ name: string }>;
    const namesFromJobs = db
      .prepare(
        `SELECT DISTINCT replace(replace(name, 'integration.', ''), '.tick', '') AS name
           FROM jobs WHERE name LIKE 'integration.%.tick'`,
      )
      .all() as Array<{ name: string }>;
    const allNames = new Set<string>();
    for (const r of namesFromState) allNames.add(r.name);
    for (const r of namesFromJobs) allNames.add(r.name);

    const kvFor = (integrationName: string, key: string): string | null => {
      const row = db
        .prepare(`SELECT value FROM integration_state WHERE integration_name = ? AND key = ?`)
        .get(integrationName, key) as { value?: string } | undefined;
      return row?.value ?? null;
    };

    const jobStats = (integrationName: string) => {
      const jobName = `integration.${integrationName}.tick`;
      const stats = db
        .prepare(
          `SELECT
            COUNT(CASE WHEN state='completed' THEN 1 END) AS ok,
            COUNT(CASE WHEN state='errored' THEN 1 END) AS err
           FROM jobs
           WHERE name = ? AND scheduled_at >= datetime('now', '-24 hours')`,
        )
        .get(jobName) as { ok: number; err: number };
      const errRow = db
        .prepare(
          `SELECT last_error FROM jobs WHERE name = ? AND state='errored' AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1`,
        )
        .get(jobName) as { last_error?: string } | undefined;
      return { ...stats, last_error: errRow?.last_error ?? null };
    };

    const rows: IntegrationStatusRow[] = [];
    for (const name of Array.from(allNames).sort()) {
      const last_attempt_at = kvFor(name, 'last_attempt_at');
      const last_ingest_at = kvFor(name, 'last_ingest_at');
      const last_ingest_count_raw = kvFor(name, 'last_ingest_count');
      const consecutive_errors_raw = kvFor(name, 'consecutive_errors');
      const s = jobStats(name);
      const partial: Omit<IntegrationStatusRow, 'status'> = {
        name,
        last_attempt_at,
        last_ingest_at,
        last_ingest_count: last_ingest_count_raw ? Number(last_ingest_count_raw) : null,
        consecutive_errors: consecutive_errors_raw ? Number(consecutive_errors_raw) : 0,
        recent_ok: s.ok,
        recent_err: s.err,
        last_error: s.last_error,
      };
      rows.push({ ...partial, status: deriveStatus(partial) });
    }

    return { ts: new Date().toISOString(), rows };
  } finally {
    closeDb(db);
  }
}

function relTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const ago = now.getTime() - t;
  const min = Math.round(ago / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

const STATUS_ICON: Record<IntegrationStatusRow['status'], string> = {
  ok: '✓',
  silent: '~',
  erroring: '!',
  broken: 'X',
  idle: '.',
};

export function printIntegrationsHuman(report: IntegrationsReport): void {
  if (report.rows.length === 0) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log('No integrations loaded.');
    return;
  }
  const now = new Date();
  const header = '  STATUS  NAME                  LAST ATTEMPT   LAST INGEST    ERRS  RECENT 24H';
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(header);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('  ' + '─'.repeat(header.length - 2));
  for (const r of report.rows) {
    const icon = STATUS_ICON[r.status];
    const name = r.name.padEnd(20);
    const attempt = relTime(r.last_attempt_at, now).padEnd(13);
    const ingest = relTime(r.last_ingest_at, now).padEnd(13);
    const errs = String(r.consecutive_errors).padStart(4);
    const recent = `${r.recent_ok} ok / ${r.recent_err} err`;
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(
      `  ${icon} ${r.status.padEnd(6)} ${name}  ${attempt}  ${ingest}  ${errs}  ${recent}`,
    );
  }
  // Surface the first broken integration's last error so the operator sees the
  // actionable detail without re-running with --json. Most "broken" errors are
  // the same OAuth message repeated across every integration of one provider.
  const broken = report.rows.find((r) => r.status === 'broken' && r.last_error);
  if (broken) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(`\n  Last error for "${broken.name}":\n  ${broken.last_error?.slice(0, 200)}`);
  }
}
