import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ShutdownReason = 'shutdown' | 'heartbeat-escalation';

export interface ShutdownStamp {
  pid: number;
  reason: ShutdownReason;
  at: string; // ISO timestamp of the write
}

/**
 * Single-use clean-shutdown stamp (spec: restart classification). Written on
 * every intentional exit path; consumed (read + deleted) exactly once by the
 * next boot's classifier, so a stale stamp can never launder a later crash.
 * Both functions swallow all errors: a stamp failure must never break a
 * shutdown or a boot.
 */
export function writeShutdownStamp(
  path: string,
  reason: ShutdownReason,
  pid: number = process.pid,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const stamp: ShutdownStamp = { pid, reason, at: new Date().toISOString() };
    writeFileSync(path, JSON.stringify(stamp), 'utf8');
  } catch {
    /* never throw on a shutdown path */
  }
}

export function consumeShutdownStamp(path: string): ShutdownStamp | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // no stamp — nothing to consume
  }
  try {
    unlinkSync(path);
  } catch {
    /* deletion failure is survivable; parse result still valid */
  }
  try {
    const s = JSON.parse(raw) as ShutdownStamp;
    if (typeof s?.pid !== 'number' || typeof s?.at !== 'string') return null;
    if (s.reason !== 'shutdown' && s.reason !== 'heartbeat-escalation') return null;
    return s;
  } catch {
    return null; // corrupt stamp = no stamp
  }
}
