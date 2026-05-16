// runtime.no_orphan_node_test_procs
//
// Catches orphan `node --test` processes left behind by the NAPI handle
// leak (CLAUDE.md runbook). Doctor-only — running from heartbeat could
// kill a legitimate test in another shell.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STALE_MS = 10 * 60 * 1000;
const TMP_PREFIXES = ['robin-multi-', 'robin-ws-', 'robin-test-'];

function findOrphanTestProcs() {
  let raw;
  try {
    // execFileSync — argv, no shell parsing; fixed argv prevents injection.
    raw = execFileSync('ps', ['-eo', 'pid,ppid,etime,command'], {
      encoding: 'utf8',
      timeout: 2000,
    });
  } catch {
    return [];
  }
  const lines = raw.split('\n').slice(1);
  const orphans = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, ppid, etime, cmd] = match;
    if (Number(ppid) !== 1) continue;
    if (!/\bnode\b.*\s--test\b/.test(cmd) && !/\bnode\b.*test_runner/.test(cmd)) continue;
    const ms = parseEtime(etime);
    if (ms < STALE_MS) continue;
    orphans.push({ pid: Number(pid), etime, cmd });
  }
  return orphans;
}

function parseEtime(s) {
  const parts = s.split(/[-:]/).map((p) => Number(p));
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 4) return (parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3]) * 1000;
  return 0;
}

function findStaleTmpDirs() {
  const base = tmpdir();
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  const stale = [];
  const cutoff = Date.now() - STALE_MS;
  for (const name of entries) {
    if (!TMP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = join(base, name);
    try {
      if (statSync(full).mtimeMs < cutoff) stale.push(full);
    } catch {
      // best-effort
    }
  }
  if (existsSync('/tmp')) {
    try {
      for (const name of readdirSync('/tmp')) {
        if (!name.startsWith('robin-test-')) continue;
        const full = `/tmp/${name}`;
        try {
          if (statSync(full).mtimeMs < cutoff) stale.push(full);
        } catch {}
      }
    } catch {}
  }
  return stale;
}

export default {
  name: 'runtime.no_orphan_node_test_procs',
  level: 'info',
  surface: 'runtime',
  phase: 'runtime',
  description: 'No orphaned (ppid=1) node --test processes older than 10 minutes, and no stale robin-test tmpdirs.',

  runWhen: {
    boot: { enabled: false },
    heartbeat: { enabled: false },
    doctor: { enabled: true },
    postInstall: { enabled: false },
  },

  async check() {
    const procs = findOrphanTestProcs();
    const tmps = findStaleTmpDirs();
    if (procs.length === 0 && tmps.length === 0) {
      return { ok: true, evidence: { procs: 0, tmps: 0 } };
    }
    return {
      ok: false,
      error: 'orphans_present',
      evidence: { procs, tmps },
    };
  },

  async repair(ctx) {
    const procs = findOrphanTestProcs();
    const tmps = findStaleTmpDirs();
    if (procs.length === 0 && tmps.length === 0) {
      return { repaired: false, action: 'nothing_to_clean' };
    }
    if (ctx?.dryRun) {
      return {
        repaired: false,
        action: 'would_kill_and_clean',
        plan: { pids: procs.map((p) => p.pid), tmpdirs: tmps },
      };
    }
    let killed = 0;
    for (const p of procs) {
      try {
        process.kill(p.pid, 'SIGTERM');
        killed++;
      } catch {
        // best-effort
      }
    }
    let cleaned = 0;
    for (const t of tmps) {
      try {
        rmSync(t, { recursive: true, force: true });
        cleaned++;
      } catch {
        // best-effort
      }
    }
    return {
      repaired: killed + cleaned > 0,
      action: 'killed_and_cleaned',
      evidence: { killed, cleaned },
    };
  },

  explain(lastResult) {
    const lines = [
      '### `runtime.no_orphan_node_test_procs`',
      '',
      '**Symptom.** `node --test` processes accumulate over Claude Code sessions; `/tmp/robin-*` directories remain after the runner prints summary.',
      '',
      '**Cause.** `@surrealdb/node` v3 embedded engines register NAPI threadsafe handles that prevent the event loop from exiting after the test runner completes. Without `--test-force-exit`, the process hangs forever.',
      '',
      '**Fix.** Use `pnpm test:file` (or any script in `package.json` — they all include `--test-force-exit`). For cleanup of existing orphans, this invariant\'s `repair --apply` kills processes with `ppid=1` and `--test` in their cmdline older than 10 minutes, plus removes stale `robin-multi-*`, `robin-ws-*`, and `robin-test-*` directories.',
    ];
    if (lastResult?.evidence?.procs?.length) {
      lines.push('', `**Orphan PIDs:** ${lastResult.evidence.procs.map((p) => p.pid).join(', ')}`);
    }
    return lines.join('\n');
  },
};
