import { nextFire, parseCron } from './cron.js';
import { recordFailure, recordSuccess, setInFlight } from './db.js';
import { dispatchNotify } from './notify.js';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function dispatchRuntime({ job, db, host, capture, embedder, tools }) {
  if (job.runtime === 'agent') {
    if (!host?.invokeLLM) throw new Error('agent runtime needs a host with invokeLLM');
    const llm = await host.invokeLLM([{ role: 'user', content: job.body }], { tier: 'deep' });
    return (llm?.content ?? '').toString();
  }
  if (job.runtime === 'internal') {
    const mod = await import(new URL(`./internal/${job.name}.js`, import.meta.url));
    const fn = mod.default;
    if (typeof fn !== 'function') throw new Error(`internal job ${job.name}: no default export`);
    const out = await fn({ db, host, capture, embedder, tools });
    return out == null ? null : String(out);
  }
  throw new Error(`unknown runtime: ${job.runtime}`);
}

export async function runOneJob({
  db,
  capture,
  host,
  embedder,
  jobs,
  tools,
  name,
  now = () => new Date(),
}) {
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`job not found: ${name}`);
  const start = Date.now();
  await setInFlight(db, name, true);

  let parsed;
  try {
    parsed = parseCron(job.schedule);
  } catch (e) {
    await recordFailure(db, name, {
      error: `bad schedule: ${e.message}`,
      duration_ms: Date.now() - start,
      next_run_at: null,
    });
    return;
  }

  const timeoutMs = Math.max(100, Math.floor(job.timeout_minutes * 60_000));
  try {
    const output = await withTimeout(
      dispatchRuntime({ job, db, host, capture, embedder, tools }),
      timeoutMs,
    );
    const next_run_at = nextFire(parsed, now());
    await recordSuccess(db, name, {
      duration_ms: Date.now() - start,
      next_run_at,
    });
    if (job.notify !== 'none' && output != null && output.length > 0) {
      try {
        await dispatchNotify({
          db,
          capture,
          name,
          notify: job.notify,
          output,
          tools,
          kind: 'success',
        });
      } catch (e) {
        console.warn(`[jobs] ${name}: notify failed: ${e.message}`);
      }
    }
  } catch (e) {
    const next_run_at = nextFire(parsed, now());
    await recordFailure(db, name, {
      error: e.message,
      duration_ms: Date.now() - start,
      next_run_at,
    });
    if (job.notify_on_failure) {
      try {
        await dispatchNotify({
          db,
          capture,
          name,
          notify: job.notify === 'none' ? 'capture' : job.notify,
          output: `[${name}] failed: ${e.message}`,
          tools,
          kind: 'failure',
        });
      } catch (notifyErr) {
        console.warn(`[jobs] ${name}: failure-notify failed: ${notifyErr.message}`);
      }
    }
  }
}
