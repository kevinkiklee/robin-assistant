// Job runner — single OS-scheduler entry point and manual invocation path.
// Usage: robin run <name> [--force | --dry-run | --no-lock]

import { writeFileSync } from 'node:fs';
import { spawn as childSpawn } from 'node:child_process';
import { safeEnv } from '../lib/safe-env.js';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { loadJob, discoverJobs } from '../lib/jobs/discovery.js';
import { jobsPaths, logTimestamp } from '../lib/jobs/paths.js';
import {
  acquireLock,
  ensureDir,
  readJSON,
  releaseLock,
  writeJSONIfChanged,
} from '../lib/jobs/atomic.js';
import { cleanupStaleLocks } from '../lib/jobs/lock-cleanup.js';
import {
  parseCron,
  cronPrev,
  expectedIntervalMs,
  inActiveWindow,
} from '../lib/jobs/cron.js';
import {
  categorizeFailure,
  shouldNotify,
  recordNotification,
  notificationText,
} from '../lib/jobs/categorize.js';
import { notify as defaultNotify } from '../lib/jobs/notify.js';
import {
  computeNextRun,
  listJobStates,
  regenIndex,
  rotateLogs,
} from '../lib/jobs/state.js';

const STDERR_BUFFER_BYTES = 4 * 1024;

function readWorkspaceConfig(workspaceDir) {
  return readJSON(resolve(workspaceDir, 'user-data/robin.config.json'), {});
}

function lastNonEmptyLine(s) {
  if (!s) return '';
  const lines = String(s).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i].trim();
  }
  return '';
}

function buildSummaryLog(fullText, exitCode, durationMs, status, n = 50) {
  const nonEmpty = String(fullText || '')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const tail = nonEmpty.slice(-n);
  const header = `# summary · status=${status} · exit=${exitCode} · duration=${durationMs}ms`;
  return [header, ...tail].join('\n') + '\n';
}

function defaultAgentCommand() {
  if (process.env.ROBIN_AGENT_COMMAND) return process.env.ROBIN_AGENT_COMMAND;
  return 'claude -p';
}

function buildAgentArgs({ agentCommand, body, contextMode = 'full' }) {
  const tokens = agentCommand.trim().split(/\s+/);
  const cmd = tokens[0];
  const args = tokens.slice(1);
  if (contextMode === 'minimal' && /claude/.test(cmd)) {
    args.push('--append-system-prompt', 'You are running headlessly. Skip session-startup loading.');
  }
  return { cmd, args, body };
}

function relativizePath(workspaceDir, p) {
  if (!p) return null;
  if (p.startsWith(workspaceDir)) return p.slice(workspaceDir.length + 1);
  return p;
}

function safeWrite(path, content) {
  try {
    ensureDir(dirname(path));
    writeFileSync(path, content);
    return true;
  } catch {
    return false;
  }
}

function humanMs(ms) {
  if (!Number.isFinite(ms)) return '∞';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function describePlan({ def }) {
  const lines = [];
  lines.push(`name: ${def.frontmatter.name}`);
  lines.push(`runtime: ${def.frontmatter.runtime}`);
  lines.push(`schedule: ${def.frontmatter.schedule || '—'}`);
  lines.push(`active: ${def.frontmatter.active ? JSON.stringify(def.frontmatter.active) : 'always'}`);
  lines.push(`enabled: ${def.frontmatter.enabled !== false ? 'yes' : 'no'}`);
  if (def.frontmatter.runtime === 'node') {
    lines.push(`command: ${def.frontmatter.command}`);
  } else {
    lines.push(`agent_command: ${defaultAgentCommand()}`);
    lines.push(`prompt_bytes: ${(def.body || '').length}`);
  }
  return lines.join('\n');
}

function decideCatchUp({ def, prevState, now }) {
  if (!def.frontmatter.schedule) return { skip: false, reason: 'no schedule' };
  if (!prevState || !prevState.last_run_at) return { skip: false, reason: 'no prior run' };
  let cron;
  try {
    cron = parseCron(def.frontmatter.schedule);
  } catch {
    return { skip: false, reason: 'cron unparseable; proceeding' };
  }
  const expected = expectedIntervalMs(cron, now);
  if (!Number.isFinite(expected)) return { skip: false, reason: 'no interval' };
  const last = new Date(prevState.last_run_at).getTime();
  const elapsed = now.getTime() - last;
  if (elapsed <= expected * 1.5) {
    return { skip: false, reason: `within interval (elapsed ${humanMs(elapsed)} <= 1.5x ${humanMs(expected)})` };
  }
  const lastMissedFire = cronPrev(cron, now);
  if (!lastMissedFire) {
    return { skip: false, reason: 'cannot compute missed fire' };
  }
  if (def.frontmatter.active && !inActiveWindow(def.frontmatter.active, lastMissedFire)) {
    return { skip: true, skipStatus: 'skipped:out-of-window', reason: 'most recent missed fire is outside active window' };
  }
  if (def.frontmatter.catch_up === false) {
    return { skip: true, skipStatus: 'skipped:no-catchup', reason: 'catch_up: false' };
  }
  return { skip: false, reason: `catching up (elapsed ${humanMs(elapsed)})` };
}

function spawnAndCapture({ file, args, workspaceDir, fullLogPath, timeoutMs, spawnFn, log, stdinPayload }) {
  return new Promise((resolvePromise) => {
    let proc;
    try {
      // Cycle-2a: spawn job subprocesses with safeEnv so secrets cannot
      // inherit via env. Job scripts that need a secret read it via
      // requireSecret() from secrets/.env directly.
      proc = spawnFn(file, args, {
        cwd: workspaceDir,
        env: safeEnv({ ROBIN_WORKSPACE: workspaceDir }),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolvePromise({ exitCode: 127, signal: null, stderrTail: err.message, fullText: err.message + '\n' });
      return;
    }

    let fullText = '';
    let stderrTail = '';
    proc.stdout.on('data', (buf) => {
      fullText += buf.toString();
    });
    proc.stderr.on('data', (buf) => {
      const s = buf.toString();
      fullText += s;
      stderrTail = (stderrTail + s).slice(-STDERR_BUFFER_BYTES);
    });

    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`timeout: sending SIGTERM`);
      try {
        proc.kill('SIGTERM');
      } catch {}
      killTimer = setTimeout(() => {
        log(`timeout: sending SIGKILL`);
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 30_000);
    }, timeoutMs);

    if (stdinPayload != null) {
      try {
        proc.stdin.end(stdinPayload);
      } catch {}
    } else {
      try {
        proc.stdin.end();
      } catch {}
    }

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      safeWrite(fullLogPath, fullText);
      resolvePromise({
        exitCode: code,
        signal,
        stderrTail,
        fullText,
        kind: timedOut ? 'timeout' : null,
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        exitCode: 127,
        signal: null,
        stderrTail: err.message,
        fullText: fullText + err.message + '\n',
      });
    });
  });
}

async function execNode({ def, workspaceDir, fullLogPath, spawnFn, log }) {
  const cmd = def.frontmatter.command;
  if (!cmd) throw new Error('command: required for runtime: node');
  const tokens = cmd.trim().split(/\s+/);
  const file = tokens[0];
  const args = tokens.slice(1);
  return spawnAndCapture({
    file,
    args,
    workspaceDir,
    fullLogPath,
    timeoutMs: (def.frontmatter.timeout_minutes || 5) * 60_000,
    spawnFn,
    log,
    stdinPayload: null,
  });
}

async function execAgent({ def, workspaceDir, fullLogPath, spawnFn, log }) {
  const agentCommand = defaultAgentCommand();
  const { cmd, args, body } = buildAgentArgs({
    agentCommand,
    body: def.body || '',
    contextMode: def.frontmatter.context_mode || 'full',
  });
  return spawnAndCapture({
    file: cmd,
    args,
    workspaceDir,
    fullLogPath,
    timeoutMs: (def.frontmatter.timeout_minutes || 30) * 60_000,
    spawnFn,
    log,
    stdinPayload: body,
  });
}

export async function run({
  workspaceDir,
  name,
  flags = {},
  now = new Date(),
  spawnFn = childSpawn,
  notifyFn = defaultNotify,
  onLog = null,
} = {}) {
  const paths = jobsPaths(workspaceDir);
  const config = readWorkspaceConfig(workspaceDir);
  const tz = (config && config.user && config.user.timezone) || null;

  const ts = logTimestamp(now);
  ensureDir(paths.locksDir);
  ensureDir(paths.logsDir);

  const runnerLogPath = paths.runnerLog(name, ts);
  const fullLogPath = paths.log(name, ts);
  const summaryLogPath = paths.summaryLog(name, ts);
  const runnerLines = [];
  const log = (line) => {
    const ms = Date.now() - now.getTime();
    const out = `[+${ms}ms] ${line}`;
    runnerLines.push(out);
    if (onLog) onLog(out);
  };

  const lockPath = paths.lockFile(name);
  let lockAcquired = false;

  const finalize = ({
    status,
    exitCode = 0,
    lastErrorLine = '',
    failureCategory = null,
    durationMs = 0,
    fullSubprocessText = '',
  }) => {
    // Write logs (best-effort)
    safeWrite(runnerLogPath, runnerLines.join('\n') + '\n');
    if (fullSubprocessText) safeWrite(fullLogPath, fullSubprocessText);
    safeWrite(summaryLogPath, buildSummaryLog(fullSubprocessText, exitCode, durationMs, status));

    // Update state JSON
    const prevState = readJSON(paths.stateJSON(name), {}) || {};
    let consecutive = prevState.consecutive_failures || 0;
    let failingSince = prevState.failing_since || null;
    let previouslyFailedUntil = prevState.previously_failed_until || null;
    let previouslyFailedDurationMs = prevState.previously_failed_duration_ms || null;

    if (status === 'failed') {
      consecutive = consecutive + 1;
      if (!failingSince) failingSince = now.toISOString();
    } else if (status === 'ok') {
      if (prevState.last_status === 'failed') {
        previouslyFailedUntil = now.toISOString();
        if (prevState.failing_since) {
          previouslyFailedDurationMs = now.getTime() - new Date(prevState.failing_since).getTime();
        }
      }
      consecutive = 0;
      failingSince = null;
    }

    let def = null;
    try {
      def = loadJob(workspaceDir, name).def;
    } catch {}
    const nextRun = def ? computeNextRun(def, new Date(now.getTime() + 60_000)) : null;

    const state = {
      ...prevState,
      name,
      runtime: def?.frontmatter?.runtime ?? prevState.runtime ?? null,
      enabled: def ? def.frontmatter.enabled !== false : prevState.enabled ?? null,
      schedule: def?.frontmatter?.schedule ?? prevState.schedule ?? null,
      active: def?.frontmatter?.active ?? prevState.active ?? null,
      last_run_at: now.toISOString(),
      last_ended_at: new Date(now.getTime() + durationMs).toISOString(),
      last_duration_ms: durationMs,
      last_exit_code: exitCode,
      last_status: status,
      last_log_path: relativizePath(workspaceDir, fullLogPath),
      last_summary_path: relativizePath(workspaceDir, summaryLogPath),
      last_runner_log_path: relativizePath(workspaceDir, runnerLogPath),
      last_failure_category: failureCategory,
      last_error_line: lastErrorLine || null,
      next_run_at: nextRun,
      consecutive_failures: consecutive,
      failing_since: failingSince,
      previously_failed_until: previouslyFailedUntil,
      previously_failed_duration_ms: previouslyFailedDurationMs,
    };

    try {
      writeJSONIfChanged(paths.stateJSON(name), state);
    } catch {}

    // Regen INDEX.md
    try {
      const { jobs } = discoverJobs(workspaceDir);
      const states = listJobStates(workspaceDir);
      regenIndex(workspaceDir, jobs, states, { generatedAt: new Date(), tz });
    } catch {}

    // Failure notification
    if (status === 'failed' && def) {
      const notifyOnFailure = def.frontmatter.notify_on_failure !== false;
      const envSuppressed = !!process.env.ROBIN_NO_NOTIFY;
      const notifyState = readJSON(paths.notificationStateFile, { last_notified: {} });
      const ok = shouldNotify({
        jobName: name,
        category: failureCategory,
        notifyOnFailure,
        envSuppressed,
        state: notifyState,
        now: now.getTime(),
      });
      if (ok) {
        const { title, body } = notificationText({
          jobName: name,
          category: failureCategory,
          errorLine: lastErrorLine,
        });
        const fired = notifyFn({ title, body });
        log(`notification ${fired ? 'fired' : 'skipped (unsupported)'}: ${title} — ${body}`);
        const newNotifyState = recordNotification({
          jobName: name,
          category: failureCategory,
          state: notifyState,
          now,
        });
        try {
          writeJSONIfChanged(paths.notificationStateFile, newNotifyState);
        } catch {}
      } else {
        log(`notification suppressed (debounced)`);
      }
    }

    // Re-write runner log with the final lines (notification status)
    safeWrite(runnerLogPath, runnerLines.join('\n') + '\n');

    // Log rotation
    try {
      const pruned = rotateLogs(workspaceDir);
      if (pruned > 0) log(`pruned ${pruned} old log files`);
    } catch {}

    if (lockAcquired) releaseLock(lockPath);

    return { status, exitCode };
  };

  // Step 1+2: load + validate
  const { def, errors } = loadJob(workspaceDir, name);
  if (!def) {
    log(`job "${name}" not found`);
    return finalize({
      status: 'failed',
      exitCode: 2,
      lastErrorLine: `job "${name}" not found`,
      failureCategory: 'definition_invalid',
    });
  }
  if (errors.length > 0) {
    const msg = errors.map((e) => `${e.path}: ${(e.errors || []).join('; ')}`).join('\n');
    log(`definition invalid: ${msg}`);
    return finalize({
      status: 'failed',
      exitCode: 2,
      lastErrorLine: msg.slice(0, 200),
      failureCategory: 'definition_invalid',
    });
  }
  log(`starting "${name}" runtime=${def.frontmatter.runtime}`);

  // Dry run
  if (flags.dryRun) {
    const plan = describePlan({ def });
    log(`dry-run: ${plan.replace(/\n/g, ' | ')}`);
    process.stdout.write(plan + '\n');
    return { status: 'dry-run', exitCode: 0 };
  }

  // Step 3: lock
  if (!flags.noLock) {
    // Sweep stale locks before attempting to acquire — prevents phantom contention
    // from previous runs that crashed without releasing their lock.
    cleanupStaleLocks(workspaceDir);
    const lockResult = acquireLock(lockPath, { host: hostname() });
    if (lockResult === 'held') {
      if (flags.force) {
        try {
          releaseLock(lockPath);
        } catch {}
        const r2 = acquireLock(lockPath, { host: hostname() });
        if (r2 !== null) {
          log(`force could not acquire lock`);
          return finalize({ status: 'skipped:locked', exitCode: 0 });
        }
        lockAcquired = true;
        log(`lock force-acquired`);
      } else {
        log(`lock held by another runner — skipping`);
        return finalize({ status: 'skipped:locked', exitCode: 0 });
      }
    } else if (lockResult === null) {
      lockAcquired = true;
      log(`lock acquired`);
    } else {
      log(`lock acquisition error: ${lockResult}`);
      return finalize({
        status: 'failed',
        exitCode: 3,
        lastErrorLine: lockResult,
        failureCategory: 'internal',
      });
    }
  }

  // Step 4: active window
  if (!flags.force && def.frontmatter.active && !inActiveWindow(def.frontmatter.active, now)) {
    log(`out of active window: skipping`);
    return finalize({ status: 'skipped:out-of-window', exitCode: 0 });
  }

  // Step 5: catch-up
  if (!flags.force) {
    const catchUpResult = decideCatchUp({
      def,
      prevState: readJSON(paths.stateJSON(name), null),
      now,
    });
    log(`catch_up decision: ${catchUpResult.reason}`);
    if (catchUpResult.skip) {
      return finalize({ status: catchUpResult.skipStatus, exitCode: 0 });
    }
  }

  // Step 6: execute
  const startMs = Date.now();
  let result;
  try {
    if (def.frontmatter.runtime === 'node') {
      result = await execNode({ def, workspaceDir, fullLogPath, spawnFn, log });
    } else if (def.frontmatter.runtime === 'agent') {
      result = await execAgent({ def, workspaceDir, fullLogPath, spawnFn, log });
    } else {
      log(`unknown runtime`);
      return finalize({
        status: 'failed',
        exitCode: 3,
        lastErrorLine: `unknown runtime: ${def.frontmatter.runtime}`,
        failureCategory: 'internal',
      });
    }
  } catch (err) {
    const durationMs = Date.now() - startMs;
    log(`internal error during exec: ${err.message}`);
    return finalize({
      status: 'failed',
      exitCode: 3,
      durationMs,
      lastErrorLine: err.message,
      failureCategory: 'internal',
    });
  }

  const durationMs = Date.now() - startMs;
  const fullSubprocessText = result.fullText;
  const exitCode = result.exitCode ?? 1;
  const status = exitCode === 0 ? 'ok' : 'failed';
  let failureCategory = null;
  let lastErrorLine = '';
  if (status === 'failed') {
    failureCategory = categorizeFailure({
      exitCode,
      signal: result.signal,
      stderrTail: result.stderrTail,
      kind: result.kind,
    });
    lastErrorLine = lastNonEmptyLine(result.stderrTail) || lastNonEmptyLine(fullSubprocessText);
  }
  log(`subprocess exited code=${exitCode} signal=${result.signal || '—'} duration=${durationMs}ms`);
  log(`status=${status}${failureCategory ? ' category=' + failureCategory : ''}`);

  return finalize({
    status,
    exitCode,
    durationMs,
    lastErrorLine,
    failureCategory,
    fullSubprocessText,
  });
}

// CLI entry point — invoked when run directly.
async function cliMain(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];
  for (const a of args) {
    if (a === '--force') flags.force = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--no-lock') flags.noLock = true;
    else positional.push(a);
  }
  const name = positional[0];
  if (!name) {
    process.stderr.write('usage: robin run <name> [--force | --dry-run | --no-lock]\n');
    process.exit(2);
  }
  const workspaceDir = process.env.ROBIN_WORKSPACE || process.cwd();
  const result = await run({
    workspaceDir,
    name,
    flags,
    onLog: (l) => process.stderr.write(l + '\n'),
  });
  if (result.status === 'failed') process.exit(result.exitCode || 1);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain(process.argv).catch((err) => {
    process.stderr.write(`runner internal error: ${err.message}\n`);
    process.exit(3);
  });
}
