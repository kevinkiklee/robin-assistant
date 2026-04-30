import { spawn as defaultSpawn } from 'node:child_process';

const ABS_KILL_DELAY_MS = 5000;

export function createRunner({
  binPath,
  cwd,
  envWhitelist,
  maxTurns,
  timeoutMs,
  maxConcurrent,
  spawnFn = defaultSpawn,
}) {
  const perKeyTail = new Map();   // key → tail Promise
  const inFlight = new Map();     // key → child reference
  let activeCount = 0;
  const globalQueue = [];         // [resolve fns]

  function buildArgs(prompt, priorSessionId) {
    const base = ['-p', prompt, '--output-format', 'json', '--max-turns', String(maxTurns)];
    return priorSessionId ? ['--resume', priorSessionId, ...base] : base;
  }

  function buildEnv() {
    const out = { ROBIN_SESSION_PLATFORM: 'discord' };
    for (const k of envWhitelist) {
      if (process.env[k] !== undefined) out[k] = process.env[k];
    }
    return out;
  }

  async function acquireGlobalSlot() {
    if (activeCount < maxConcurrent) {
      activeCount++;
      return;
    }
    await new Promise(r => globalQueue.push(r));
    activeCount++;
  }

  function releaseGlobalSlot() {
    activeCount--;
    const next = globalQueue.shift();
    if (next) next();
  }

  function spawnOnce(key, args) {
    return new Promise((resolve, reject) => {
      const child = spawnFn(binPath, args, {
        cwd, env: buildEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });
      inFlight.set(key, child);

      let stdout = '';
      let stderrTail = '';
      const STDERR_CAP = 8 * 1024;

      child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
      child.stderr.on('data', d => {
        stderrTail += d.toString('utf-8');
        if (stderrTail.length > STDERR_CAP) {
          stderrTail = stderrTail.slice(-STDERR_CAP);
        }
      });

      let timedOut = false;
      let killTimer;
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        }, ABS_KILL_DELAY_MS);
      }, timeoutMs);

      child._cancelMarker = false;

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        inFlight.delete(key);
        if (timedOut) {
          const e = new Error('claude timed out');
          e.code = 'TIMEOUT';
          e.stderrTail = stderrTail;
          return reject(e);
        }
        if (child._cancelMarker) {
          const e = new Error('cancelled');
          e.code = 'CANCELLED';
          return reject(e);
        }
        if (code !== 0) {
          const e = new Error(`claude exited ${code}`);
          e.code = 'NONZERO_EXIT';
          e.exitCode = code;
          e.stderrTail = stderrTail;
          return reject(e);
        }
        let parsed;
        try { parsed = JSON.parse(stdout); } catch (err) {
          const e = new Error('failed to parse claude json output');
          e.code = 'PARSE_FAILED';
          e.stderrTail = stderrTail;
          return reject(e);
        }
        resolve({
          result: parsed.result ?? '',
          sessionId: parsed.session_id ?? null,
          costUsd: parsed.total_cost_usd ?? 0,
          isError: parsed.is_error === true,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        inFlight.delete(key);
        err.stderrTail = stderrTail;
        reject(err);
      });
    });
  }

  async function runOnce({ key, prompt, priorSessionId }) {
    await acquireGlobalSlot();
    try {
      try {
        return await spawnOnce(key, buildArgs(prompt, priorSessionId));
      } catch (err) {
        if (priorSessionId && (err.code === 'NONZERO_EXIT' || err.code === 'PARSE_FAILED')) {
          // One automatic fresh retry without --resume.
          return await spawnOnce(key, buildArgs(prompt, null));
        }
        throw err;
      }
    } finally {
      releaseGlobalSlot();
    }
  }

  return {
    run({ key, prompt, priorSessionId }) {
      const prev = perKeyTail.get(key) ?? Promise.resolve();
      const next = prev.catch(() => {}).then(() => runOnce({ key, prompt, priorSessionId }));
      perKeyTail.set(key, next.catch(() => {}));
      return next;
    },
    cancel(key) {
      const child = inFlight.get(key);
      if (!child) return false;
      child._cancelMarker = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      return true;
    },
    inFlightCount() { return inFlight.size; },
  };
}
