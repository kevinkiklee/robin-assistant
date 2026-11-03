import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEALTH_URL } from './migrate.ts';

const NOTICE_INTERVAL_MS = 60 * 60_000;
const HEALTH_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 5_000;

interface Stamp {
  down: boolean;
  /** Last loud (down) notice; kept across recoveries so a flapping daemon can't spam. */
  lastLoudAt: number | null;
  /** Last silent recovery notice. */
  lastBackAt: number | null;
}

type Notify = (p: { title: string; message: string; silent?: boolean }) => Promise<unknown>;

export function stampPath(userData: string): string {
  return join(userData, 'state', 'runtime', 'watchdog.json');
}

function readStamp(userData: string): Stamp {
  try {
    const raw = JSON.parse(readFileSync(stampPath(userData), 'utf8')) as Partial<Stamp>;
    const n = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const legacy = (raw as { lastNotifiedAt?: unknown }).lastNotifiedAt;
    return {
      down: raw.down === true,
      lastLoudAt: n(raw.lastLoudAt) ?? n(legacy),
      lastBackAt: n(raw.lastBackAt),
    };
  } catch {
    return { down: false, lastLoudAt: null, lastBackAt: null };
  }
}

function writeStamp(userData: string, s: Stamp): void {
  const path = stampPath(userData);
  mkdirSync(join(userData, 'state', 'runtime'), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s)}\n`);
  renameSync(tmp, path);
}

async function defaultFetchHealth(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function defaultNotify(p: Parameters<Notify>[0]): Promise<unknown> {
  const { notifyOperator } = await import('../notify/operator.ts');
  return notifyOperator(p);
}

/**
 * Liveness check, run from a systemd timer. Down: one loud notice per hour.
 * Recovery: one silent notice. State lives in `state/runtime/watchdog.json`.
 */
export async function watchdog(opts: {
  userData: string;
  fetchHealth?: () => Promise<boolean>;
  notify?: Notify;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<'ok' | 'down-notified' | 'down-quiet'> {
  const fetchHealth = opts.fetchHealth ?? defaultFetchHealth;
  const notify = opts.notify ?? defaultNotify;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // biome-ignore lint/suspicious/noConsole: CLI output is the watchdog's log
  const log = opts.log ?? ((l: string) => console.log(l));
  const now = (opts.now ?? Date.now)();
  const stamp = readStamp(opts.userData);
  let healthy = await fetchHealth().catch(() => false);
  if (!healthy) {
    // One retry: a restart (e.g. `daemon install`) must not read as an outage.
    await sleep(RETRY_DELAY_MS);
    healthy = await fetchHealth().catch(() => false);
  }
  // Stamp first, notice second: if the stamp can't be written, stay silent
  // rather than re-notify on every tick.
  const commit = (next: Stamp): boolean => {
    try {
      writeStamp(opts.userData, next);
      return true;
    } catch (err) {
      log(
        `watchdog: cannot write stamp (${err instanceof Error ? err.message : String(err)}); not notifying`,
      );
      return false;
    }
  };
  const send = async (p: Parameters<Notify>[0]): Promise<void> => {
    try {
      await notify(p);
    } catch {
      /* a failed notice must not fail the timer */
    }
  };
  if (healthy) {
    if (stamp.down) {
      const due = stamp.lastBackAt === null || now - stamp.lastBackAt >= NOTICE_INTERVAL_MS;
      if (!commit({ ...stamp, down: false, lastBackAt: due ? now : stamp.lastBackAt })) return 'ok';
      if (due) {
        await send({
          title: "Robin's daemon is back",
          message: 'The daemon on the VM is answering again.',
          silent: true,
        });
      }
    }
    return 'ok';
  }
  if (stamp.lastLoudAt !== null && now - stamp.lastLoudAt < NOTICE_INTERVAL_MS) {
    if (!stamp.down) commit({ ...stamp, down: true });
    return 'down-quiet';
  }
  if (!commit({ ...stamp, down: true, lastLoudAt: now })) return 'down-quiet';
  await send({
    title: "Robin's daemon is not answering on the VM",
    message: `No healthy reply from ${HEALTH_URL}. Check: systemctl --user status robin-daemon`,
  });
  return 'down-notified';
}
