// Durable record of every auto-land attempt, hold and probation result
// (system/agent/auto-land.ts, land-probation.ts). The nightly reliability audit
// reads it to show K what auto-fix already tried. Git history isn't that record:
// main gets squashed, and held branches never reach it.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LandLogEntry {
  ts?: string;
  branch: string;
  landed: boolean;
  reason: string;
  files: string[];
  commit?: string;
}

export const landLogPath = (userDataDir: string) =>
  join(userDataDir, 'state', 'runtime', 'auto-land-log.jsonl');

export function appendLandLog(userDataDir: string, e: LandLogEntry): void {
  try {
    mkdirSync(dirname(landLogPath(userDataDir)), { recursive: true });
    appendFileSync(
      landLogPath(userDataDir),
      `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`,
      'utf8',
    );
  } catch {
    /* bookkeeping never breaks a land */
  }
}

/** Land-log entries newer than `sinceMs`, oldest first. Missing/corrupt lines skip. */
export function readLandLog(userDataDir: string, sinceMs: number): LandLogEntry[] {
  let raw = '';
  try {
    raw = readFileSync(landLogPath(userDataDir), 'utf8');
  } catch {
    return [];
  }
  const out: LandLogEntry[] = [];
  for (const line of raw.split('\n')) {
    try {
      const e = JSON.parse(line) as LandLogEntry;
      if (e.ts && Date.parse(e.ts) >= sinceMs) out.push(e);
    } catch {
      /* blank or torn line */
    }
  }
  return out;
}
