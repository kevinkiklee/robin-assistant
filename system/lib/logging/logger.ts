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
    return pino(opts, pino.destination({ dest: cfg.file, sync: false, mkdir: true }));
  }
  return pino(opts);
}
