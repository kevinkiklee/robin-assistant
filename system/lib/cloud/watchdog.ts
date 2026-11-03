import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HEALTH_URL = 'http://127.0.0.1:41273/health';
const NOTICE_INTERVAL_MS = 60 * 60_000;
const HEALTH_TIMEOUT_MS = 5_000;

interface Stamp {
  down: boolean;
  lastNotifiedAt: number;
}

type Notify = (p: { title: string; message: string; silent?: boolean }) => Promise<unknown>;

export function stampPath(userData: string): string {
  return join(userData, 'state', 'runtime', 'watchdog.json');
}

function readStamp(userData: string): Stamp {
  try {
    const raw = JSON.parse(readFileSync(stampPath(userData), 'utf8')) as Partial<Stamp>;
    return {
      down: raw.down === true,
      lastNotifiedAt: typeof raw.lastNotifiedAt === 'number' ? raw.lastNotifiedAt : 0,
    };
  } catch {
    return { down: false, lastNotifiedAt: 0 };
  }
}

function writeStamp(userData: string, s: Stamp): void {
  const path = stampPath(userData);
  mkdirSync(join(userData, 'state', 'runtime'), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s)}\n`);
  renameSync(tmp, path);
}

export async function defaultFetchHealth(): Promise<boolean> {
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
}): Promise<'ok' | 'down-notified' | 'down-quiet'> {
  const fetchHealth = opts.fetchHealth ?? defaultFetchHealth;
  const notify = opts.notify ?? defaultNotify;
  const now = (opts.now ?? Date.now)();
  const stamp = readStamp(opts.userData);
  const healthy = await fetchHealth().catch(() => false);
  const send = async (p: Parameters<Notify>[0]): Promise<void> => {
    try {
      await notify(p);
    } catch {
      /* a failed notice must not fail the timer */
    }
  };
  if (healthy) {
    if (stamp.down) {
      await send({
        title: "Robin's daemon is back",
        message: 'The daemon on the VM is answering again.',
        silent: true,
      });
      writeStamp(opts.userData, { down: false, lastNotifiedAt: stamp.lastNotifiedAt });
    }
    return 'ok';
  }
  if (stamp.down && now - stamp.lastNotifiedAt < NOTICE_INTERVAL_MS) return 'down-quiet';
  await send({
    title: "Robin's daemon is not answering on the VM",
    message: `No healthy reply from ${HEALTH_URL}. Check: systemctl --user status robin-daemon`,
  });
  writeStamp(opts.userData, { down: true, lastNotifiedAt: now });
  return 'down-notified';
}
