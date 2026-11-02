import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { RobinDb } from '../../brain/memory/db.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { recordAlert, resolveAlert } from './alert-store.ts';
import { hostSleptSince } from './host-sleep.ts';

/** A stall this long means synchronous work starved every timer, /health included. */
export const LOOP_BLOCKED_MS = 10_000;
/** Below this for a whole window, the stall is over. */
const LOOP_CLEAR_MS = 2_000;
const WINDOW_MS = 60_000;

export type LagVerdict = 'blocked' | 'clear' | 'hold';

/**
 * Judge one window. A host sleep shows up as a giant "delay" too (the loop was
 * suspended, not busy), so a window in which wall time ran ahead of monotonic
 * time, or in which the kernel reports a sleep/wake (`hostSlept`), is ignored.
 * The kernel check is the one that works on macOS — see host-sleep.ts.
 */
export function judgeLag(maxDelayMs: number, sleptMs: number, hostSlept = false): LagVerdict {
  if (hostSlept || sleptMs > WINDOW_MS) return 'hold';
  if (maxDelayMs >= LOOP_BLOCKED_MS) return 'blocked';
  if (maxDelayMs < LOOP_CLEAR_MS) return 'clear';
  return 'hold';
}

/**
 * Watches the daemon's event loop and raises `daemon.event_loop_blocked` when a
 * synchronous stretch starves it. The embedder's eligibility query ran 67 s of
 * synchronous SQLite every minute for weeks (fixed by migration 038); nothing
 * reported it — the only symptoms were a slow /health and restarts blamed on
 * other things. This makes the next such hot path an alert, not a mystery.
 */
export class LoopLagWatch {
  private log = createLogger({ module: 'loop-lag' });
  private hist = monitorEventLoopDelay({ resolution: 50 });
  private timer: NodeJS.Timeout | null = null;
  private lastWall = Date.now();
  private lastMono = performance.now();

  constructor(
    private db: RobinDb,
    private describe: () => string = () => '',
    private sleepProbe?: () => number | null,
  ) {}

  start(): void {
    if (this.timer) return;
    this.hist.enable();
    this.timer = setInterval(() => this.check(), WINDOW_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.hist.disable();
  }

  private check(): void {
    const wall = Date.now();
    const mono = performance.now();
    const slept = wall - this.lastWall - (mono - this.lastMono);
    const windowStart = this.lastWall;
    this.lastWall = wall;
    this.lastMono = mono;
    const maxMs = this.hist.max / 1e6;
    const p99Ms = this.hist.percentile(99) / 1e6;
    this.hist.reset();
    try {
      // Probe the kernel only when the window already looks blocked — it spawns.
      const hostSlept = maxMs >= LOOP_BLOCKED_MS && hostSleptSince(windowStart, this.sleepProbe);
      const verdict = judgeLag(maxMs, slept, hostSlept);
      if (hostSlept) {
        this.log.info({ max_ms: Math.round(maxMs) }, 'loop delay spans a host sleep — not a stall');
      }
      if (verdict === 'blocked') {
        const context = this.describe();
        const message = `event loop blocked up to ${(maxMs / 1000).toFixed(1)} s in the last minute (p99 ${(p99Ms / 1000).toFixed(1)} s)${context ? ` — ${context}` : ''}`;
        this.log.warn({ max_ms: Math.round(maxMs), p99_ms: Math.round(p99Ms), context }, message);
        recordAlert(this.db, {
          severity: 'warning',
          source: 'daemon',
          key: 'daemon.event_loop_blocked',
          message,
        });
      } else if (verdict === 'clear') {
        resolveAlert(this.db, 'daemon', 'daemon.event_loop_blocked');
      }
    } catch (err) {
      this.log.warn({ err }, 'loop-lag check failed');
    }
  }
}
