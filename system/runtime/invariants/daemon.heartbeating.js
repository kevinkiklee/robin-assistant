// daemon.heartbeating
//
// The keystone meta-invariant. Every other invariant's cached-read trust
// depends on this one. Runs only at doctor trigger — running it at
// heartbeat would be tautological (the heartbeat IS what writes the
// state file mtime).
//
// Without this invariant, doctor can't distinguish "Robin is fine" from
// "daemon died 4 hours ago and we're reading stale state."

import { existsSync, readFileSync, statSync } from 'node:fs';
import { paths } from '../../config/data-store.js';

// Daemon heartbeat tick interval is 60s. We tolerate up to 2x that before
// flagging the state as stale.
const HEARTBEAT_INTERVAL_MS = 60_000;
const STALE_MULTIPLIER = 2;

function readDaemonPid() {
  const statePath = paths.data.daemonState();
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return Number.isInteger(parsed?.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

export default {
  name: 'daemon.heartbeating',
  level: 'critical',
  surface: 'daemon',
  phase: 'meta',
  description:
    'Daemon heartbeat is writing the invariants-state.json file within 2× the heartbeat interval.',

  runWhen: {
    // Self-check: cannot run from heartbeat (it IS the heartbeat).
    boot: { enabled: false },
    heartbeat: { enabled: false },
    doctor: { enabled: true },
    postInstall: { enabled: false },
  },

  async check() {
    const statePath = paths.data.invariantsState();
    if (!existsSync(statePath)) {
      return { ok: false, error: 'no_state_file', evidence: { path: statePath } };
    }
    let mtime;
    try {
      mtime = statSync(statePath).mtimeMs;
    } catch (e) {
      return { ok: false, error: `stat_failed:${e.message}` };
    }
    const age = Date.now() - mtime;
    const limit = STALE_MULTIPLIER * HEARTBEAT_INTERVAL_MS;
    if (age > limit) {
      return {
        ok: false,
        error: 'heartbeat_stale',
        evidence: {
          age_ms: age,
          limit_ms: limit,
          last_write: new Date(mtime).toISOString(),
        },
      };
    }
    return { ok: true, evidence: { age_ms: age, limit_ms: limit } };
  },

  async repair(ctx) {
    const pid = readDaemonPid();
    if (pid == null) return { repaired: false, error: 'no_daemon_pid' };
    if (ctx?.dryRun) {
      return { repaired: false, action: 'would_sigterm_daemon', plan: { pid } };
    }
    try {
      process.kill(pid, 'SIGTERM');
      return { repaired: true, action: 'sigterm_sent', evidence: { pid } };
    } catch (e) {
      return { repaired: false, error: e.message ?? 'kill_failed' };
    }
  },

  explain(lastResult) {
    const lines = [
      '### `daemon.heartbeating`',
      '',
      '**Symptom.** `robin doctor` shows stale data; cached invariant results all say "checked 4h ago"; daemon log silent.',
      '',
      "**Cause.** Daemon is wedged or has been killed without launchd respawning it. The heartbeat tick — which writes `user-data/runtime/invariants-state.json` every 60s — hasn't fired.",
      '',
      '**Fix.** Invariant SIGTERMs the daemon PID (read from daemon-state.json). launchd respawns it. One attempt; subsequent failure → manual. This is the same one-shot pattern as `mcp.daemon_responds` and for the same reason: prevent the old plist KeepAlive infinite-respawn loop.',
    ];
    if (lastResult?.evidence?.age_ms != null) {
      const ageMin = Math.round(lastResult.evidence.age_ms / 1000 / 60);
      lines.push('', `**Last heartbeat:** ${ageMin} minutes ago.`);
    }
    return lines.join('\n');
  },
};
