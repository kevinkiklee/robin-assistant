import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { consumeShutdownStamp } from './shutdown-stamp.ts';

export type BootClass = 'clean-shutdown' | 'heartbeat-escalation' | 'system-reboot' | 'crash';

export interface BootEntry {
  at: string; // ISO timestamp of this boot
  class: BootClass;
}

const MAX_ENTRIES = 20;

/**
 * Classify how the previous daemon life ended (spec: restart classification).
 * Priority: a consumed stamp explains the death exactly once; absent a stamp,
 * an OS reboot after the previous daemon boot explains it; otherwise it is an
 * unexplained crash — suspicious-by-default per the error doctrine.
 */
export function classifyBoot(opts: {
  stampPath: string;
  /** `at` of the most recent boots.json entry, or null on first boot. */
  prevBootAt: string | null;
  /** Kernel boot time in epoch ms: Date.now() - os.uptime() * 1000. */
  systemBootMs: number;
  /**
   * PID read from the stale pidfile before it was overwritten by this boot,
   * or null/absent if unknown. When present, a consumed stamp only counts as
   * ours if its pid matches — otherwise it belonged to some other process and
   * cannot launder a crash that happened in between. Absent/null preserves
   * prior behavior (stamp presence alone decides) for callers without
   * pidfile knowledge.
   */
  prevPid?: number | null;
}): BootClass {
  const stamp = consumeShutdownStamp(opts.stampPath);
  if (stamp && (opts.prevPid == null || stamp.pid === opts.prevPid))
    return stamp.reason === 'heartbeat-escalation' ? 'heartbeat-escalation' : 'clean-shutdown';
  if (opts.prevBootAt !== null) {
    const prevMs = Date.parse(opts.prevBootAt);
    if (Number.isFinite(prevMs) && opts.systemBootMs > prevMs) return 'system-reboot';
  }
  return 'crash';
}

/** Raw entry list; legacy plain-ISO-string entries pass through untouched. */
export function readBootEntries(bootsPath: string): Array<BootEntry | string> {
  try {
    const parsed = JSON.parse(readFileSync(bootsPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendBootEntry(bootsPath: string, entry: BootEntry): void {
  try {
    mkdirSync(dirname(bootsPath), { recursive: true });
    const entries = readBootEntries(bootsPath);
    entries.push(entry);
    writeFileSync(bootsPath, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    /* boot recording must never abort daemon start */
  }
}

/** `at` of the most recent entry regardless of shape, or null. */
export function lastBootAt(bootsPath: string): string | null {
  const entries = readBootEntries(bootsPath);
  const last = entries.at(-1);
  if (typeof last === 'string') return last;
  if (last && typeof last.at === 'string') return last.at;
  return null;
}
