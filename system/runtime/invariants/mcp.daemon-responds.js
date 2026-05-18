// mcp.daemon_responds
//
// Daemon HTTP /healthz returns ok within a short timeout. Repair: SIGTERM
// to the daemon; launchd respawns it. One attempt; subsequent failure goes
// manual (avoids the old plist KeepAlive loop).

import { existsSync, readFileSync } from 'node:fs';
import { paths } from '../../config/data-store.js';

const PROBE_TIMEOUT_MS = 1000;

function readDaemonPort() {
  const statePath = paths.data.daemonState();
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return Number.isInteger(parsed?.port) ? parsed.port : null;
  } catch {
    return null;
  }
}

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

async function probeHealthz(port, { fetchFn = globalThis.fetch } = {}) {
  try {
    const resp = await fetchFn(`http://127.0.0.1:${port}/healthz`, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!resp.ok) return { ok: false, error: `http_${resp.status}` };
    const body = await resp.json().catch(() => null);
    if (body?.ok !== true) return { ok: false, error: 'body_not_ok' };
    return { ok: true, evidence: { status: resp.status } };
  } catch (e) {
    return { ok: false, error: e.message ?? 'fetch_failed' };
  }
}

export default {
  name: 'mcp.daemon_responds',
  level: 'critical',
  surface: 'mcp',
  phase: 'mcp',
  description: 'Daemon HTTP /healthz returns ok within 1 second.',

  remediation: [
    'invariant attempts a one-shot SIGTERM (launchd respawns the daemon)',
    'if symptom persists: `kill <pid>` and tail `user-data/runtime/logs/daemon.log` for hangs',
    'check daemon-state.json port matches the configured `mcp.port`',
  ],

  runWhen: {
    boot: { enabled: false },
    heartbeat: { enabled: true, cooldownMs: 60_000 },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },

  async enabled() {
    return readDaemonPort() != null;
  },

  async check() {
    const port = readDaemonPort();
    if (port == null) return { ok: false, error: 'no_daemon_state' };
    return probeHealthz(port);
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

  explain() {
    return [
      '### `mcp.daemon_responds`',
      '',
      "**Symptom.** `mcp__robin__*` tools fail with connection errors; the agent can't reach the daemon despite launchctl showing it loaded.",
      '',
      '**Cause.** Daemon process wedged — usually a stuck async operation, embedder hang, or DB lock.',
      '',
      '**Fix.** SIGTERM the daemon PID; launchd respawns it. The invariant attempts this once; subsequent failures escalate to manual (avoids the old plist KeepAlive infinite-respawn loop).',
    ].join('\n');
  },
};
