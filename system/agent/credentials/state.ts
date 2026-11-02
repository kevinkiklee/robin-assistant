import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CredentialName } from './config.ts';

export interface LimitState {
  status: 'allowed_warning' | 'rejected';
  scope: 'all' | 'opus' | 'sonnet';
  resetsAtMs?: number;
  observedAtMs: number;
  type?: string;
  utilization?: number;
  /** Default 'limit'. */
  reason?: 'limit' | 'auth';
}

export interface CredentialState {
  fingerprint: string;
  firstSeenAtMs: number;
  limits: LimitState[];
  /** Last soft-signal times, pruned to 10 min. */
  softHitsAtMs?: number[];
  lastUsedAtMs?: number;
  lastExpiryNoticeAtMs?: number;
  lastLimitNoticeAtMs?: number;
}

export interface ChainState {
  version: 1;
  pinned?: CredentialName;
  /** Keyed by Credential.id. */
  credentials: Record<string, CredentialState>;
}

function empty(): ChainState {
  return { version: 1, credentials: {} };
}

export function statePath(userData: string): string {
  return join(userData, 'state', 'runtime', 'claude-credentials.json');
}

export function scopeOf(type?: string): LimitState['scope'] {
  if (type === 'seven_day_opus') return 'opus';
  if (type === 'seven_day_sonnet') return 'sonnet';
  return 'all';
}

/**
 * JSON state shared by several processes (daemon, MCP servers, detached children).
 * Writes go to a unique tmp file then `rename`, so readers never see a partial file.
 */
export class CredentialStateStore {
  readonly path: string;
  readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  /** Missing, corrupt or wrong-version files read as empty state; never throws. */
  read(): ChainState {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<ChainState> | null;
      if (
        !parsed ||
        parsed.version !== 1 ||
        typeof parsed.credentials !== 'object' ||
        parsed.credentials === null
      ) {
        return empty();
      }
      return parsed as ChainState;
    } catch {
      return empty();
    }
  }

  /** read -> fn -> atomic write. Returns the new state. */
  update(fn: (s: ChainState) => void): ChainState {
    const state = this.read();
    fn(state);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // tmp never created
      }
      throw err;
    }
    return state;
  }
}
