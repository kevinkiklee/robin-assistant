import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { REDACT_PATHS } from './redact.ts';

export interface LoggerConfig {
  /** Absolute path to log file. If undefined, logs to stdout. */
  file?: string;
  /** Log level. */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  /** Module tag, attached to every log line as `module` field. */
  module: string;
  /**
   * Write the file destination synchronously. Default false (async, via
   * pino's SonicBoom worker thread) — the right trade for high-volume,
   * long-lived loggers (the daemon), where blocking every write on disk I/O
   * would hurt throughput.
   *
   * Set true for short-lived processes whose diagnostic lines are typically
   * followed by `process.exit()` in the same tick (a freshly-opened detached
   * cognition child logging "openDb failed" / "SIGTERM received" / "deadline
   * exceeded" and exiting immediately after). A brand-new async destination's
   * first write can lose the line entirely if the process exits before
   * SonicBoom's worker thread finishes opening the file — reproduced 100%
   * across ~15 runs (2026-08-11 review). Synchronous writes have no such
   * race: the write is on disk before `createLogger`'s caller's next line runs.
   */
  sync?: boolean;
}

export function createLogger(cfg: LoggerConfig): Logger {
  const opts: LoggerOptions = {
    level: cfg.level ?? 'info',
    base: { module: cfg.module, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
  if (cfg.file) {
    mkdirSync(dirname(cfg.file), { recursive: true });
    return pino(opts, pino.destination({ dest: cfg.file, sync: !!cfg.sync, mkdir: true }));
  }
  return pino(opts);
}
