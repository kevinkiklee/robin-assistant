// Hand-off from the nightly reliability audit to the autonomous runner: the
// audit writes one request when it finds something to fix, and the runner's
// next tick dispatches K (health remediation) with it ahead of the round-robin.
// A file, not a direct spawn: the audit runs inside the daemon's 120s job tick,
// and the runner already owns the single-flight lock, benching and spend caps.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RemediationRequest {
  /** 'YYYY-MM-DD' of the audit that asked. */
  date: string;
  createdAt: string;
  goal: string;
  /** Dispatches so far. The request survives until K completes a run on it, so
   *  a skipped or failed run is retried — up to MAX_ATTEMPTS, then it waits
   *  for the next audit. */
  attempts?: number;
}

export const MAX_ATTEMPTS = 3;

/** A request older than this is stale — the next audit will have re-judged it. */
export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export function remediationRequestPath(userDataDir: string): string {
  return join(userDataDir, 'state', 'runtime', 'remediation-request.json');
}

export function writeRemediationRequest(userDataDir: string, req: RemediationRequest): void {
  const path = remediationRequestPath(userDataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(req, null, 1), 'utf8');
  renameSync(tmp, path);
}

/** Read without consuming. Missing, corrupt or stale → null. */
export function peekRemediationRequest(userDataDir: string, now: Date): RemediationRequest | null {
  try {
    const r = JSON.parse(
      readFileSync(remediationRequestPath(userDataDir), 'utf8'),
    ) as RemediationRequest;
    if (typeof r?.goal !== 'string' || !r.goal.trim()) return null;
    const age = now.getTime() - Date.parse(r.createdAt);
    return Number.isFinite(age) && age <= REQUEST_TTL_MS ? r : null;
  } catch {
    return null;
  }
}

export function clearRemediationRequest(userDataDir: string): void {
  try {
    unlinkSync(remediationRequestPath(userDataDir));
  } catch {
    /* already gone */
  }
}

/**
 * Clear the request only if it's still the one `createdAt` names — a newer
 * audit's request, written while K worked on the old one, survives.
 */
export function clearRemediationRequestIf(userDataDir: string, createdAt: string): void {
  try {
    const r = JSON.parse(
      readFileSync(remediationRequestPath(userDataDir), 'utf8'),
    ) as RemediationRequest;
    if (r?.createdAt === createdAt) clearRemediationRequest(userDataDir);
  } catch {
    /* absent or unreadable — nothing to clear */
  }
}
