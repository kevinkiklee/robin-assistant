import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surql } from 'surrealdb';
import { biographerProcess } from '../../cognition/biographer/pipeline.js';
import { createBiographerQueue } from '../../cognition/biographer/queue.js';
import { garbageCollect, upsertFromDiscovered } from '../../cognition/jobs/db.js';
import { discoverJobs } from '../../cognition/jobs/loader.js';
import { planNextRunAt } from '../../cognition/jobs/scheduler-ext.js';
import { ensureHome, paths } from '../../config/data-store.js';
import { readConfig } from '../../config/paths.js';
import { envFilePath } from '../../config/secrets.js';
import { close, connect, defaultDbUrl } from '../../data/db/client.js';
import { createEmbedder } from '../../data/embed/factory.js';
import { resetInFlightFlags } from '../../io/integrations/_framework/boot-cleanup.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { loadManifests } from '../../io/integrations/_framework/manifest-loader.js';
import { createRepeatQueryDetector } from '../../io/mcp/implicit-signals.js';
import { detectHost } from '../hosts/detect.js';
import { createIdleEmbedder } from './idle-embedder.js';
import { runIntrospection } from './introspection.js';
import { retryWithBackoff } from './retry.js';
import { getCliVersion } from './version-handshake.js';

const BUILTIN_JOBS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'jobs', 'builtin');

/**
 * Boot the daemon: ensure home, open DB, detect drift, build embedder
 * (health-checked with retry), run introspection, detect host, build
 * biographer queue + capture, load integration manifests + start gateways,
 * discover jobs.
 *
 * Returns a `ctx` object consumed by tools, routes, lifecycle, and the
 * scheduler. The host binding is exposed as a getter so the host-watchdog
 * bucket's setHost() mutation is observable everywhere ctx.host is read.
 *
 * On a hard boot failure (no profile, profile drift, embedder health
 * exhausts retries), this throws — startDaemon's lifecycle.fail() handles it.
 */
export async function boot() {
  const version = await getCliVersion();
  const startedAt = new Date();
  await ensureHome();
  if (!existsSync(envFilePath())) {
    console.warn(`[daemon] no secrets file at ${envFilePath()} — integrations will fail.`);
    console.warn(
      '         Run: robin secrets import --from <v1-user-data>  (or: robin secrets set <KEY>)',
    );
  }

  const dbHandle = await connect({ engine: await defaultDbUrl() });

  // Profile-drift detection.
  const cfg = await readConfig();
  if (!cfg?.embedder_profile) {
    throw new Error('no embedder profile configured. Run `robin install` first.');
  }
  {
    const [rows] = await dbHandle
      .query(surql`SELECT * FROM type::record('runtime', 'embedder')`)
      .collect();
    const runtimeProfile = rows?.[0]?.value?.profile;
    if (runtimeProfile && runtimeProfile !== cfg.embedder_profile) {
      throw new Error(
        `config drift detected:\n  config.json says: ${cfg.embedder_profile}\n  runtime:embedder says: ${runtimeProfile}\nRun \`robin embedder switch ${cfg.embedder_profile}\` to migrate the schema, or revert config.json.`,
      );
    }
  }

  const idleEmbedder = createIdleEmbedder({
    factory: createEmbedder,
    idleMs: 600_000,
  });

  // Embedder health check with retry (~35s worst case).
  try {
    await retryWithBackoff(
      async () => {
        const embedder = await idleEmbedder.get();
        await embedder.healthCheck();
      },
      {
        attempts: 3,
        perAttemptTimeoutMs: 10_000,
        backoffMs: [1000, 4000, 0],
        onRetry: (err, attempt) => {
          console.warn(
            `[daemon] embedder health attempt ${attempt} failed: ${err.message}; retrying`,
          );
        },
      },
    );
  } catch (e) {
    const profile = cfg.embedder_profile;
    console.error(`[daemon] embedder health check failed: ${e.message}`);
    if (profile === 'qwen3-4096') {
      const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
      console.error(
        `  Verify Ollama is reachable at ${host} and that qwen3-embedding:8b is installed.\n  Install: brew install ollama && ollama pull qwen3-embedding:8b`,
      );
    } else if (profile === 'gemini-3072') {
      console.error(
        '  Missing or invalid GEMINI_API_KEY. Run `robin secret set GEMINI_API_KEY <your_key>`.',
      );
    }
    throw e;
  }

  // Introspection (fail-soft).
  try {
    const introspection = await runIntrospection(dbHandle);
    if (!introspection.ok && introspection.findings.length > 0) {
      for (const f of introspection.findings) {
        console.warn(
          `[daemon] introspection warning — ${f.kind}${f.path ? `: ${f.path}` : ''}${f.detail ? ` (${f.detail})` : ''}`,
        );
      }
    }
  } catch (e) {
    console.warn(`[daemon] introspection failed (non-fatal): ${e.message}`);
  }

  // Host detect (may be null — host-watchdog bucket retries).
  let _host = null;
  try {
    _host = await detectHost();
  } catch (e) {
    console.warn(
      `[daemon] no host at boot: ${e.message}; scheduler dispatcher disabled until detected`,
    );
  }

  const embedderWrap = {
    isLoaded: () => false,
    embed: async (text) => (await idleEmbedder.get()).embed(text),
  };
  const detector = createRepeatQueryDetector({});

  // Biographer queue + wrapper. The worker resolves the host via the live ctx
  // accessor so a watchdog-promoted host is picked up automatically.
  let _ctxRef = null;
  const queue = createBiographerQueue({
    worker: async (eventId) => {
      const e = await idleEmbedder.get();
      const h = _ctxRef?.host ?? _host;
      await biographerProcess(dbHandle, e, h, eventId);
    },
    dedupe: true,
    maxPending: 1000,
  });
  let lastBiographerRunAt = null;
  const queueWrap = {
    enqueue: (id) => {
      const ret = queue.enqueue(id);
      if (ret && typeof ret.then === 'function') {
        ret
          .then(() => {
            lastBiographerRunAt = new Date().toISOString();
          })
          .catch((e) =>
            console.warn(`[biographer] enqueue/process failed for ${id}: ${e.message}`),
          );
        return ret;
      }
      return Promise.resolve(ret);
    },
    get lastRunAt() {
      return lastBiographerRunAt;
    },
    get pendingDepth() {
      return queue.pendingDepth;
    },
    get skippedSinceBoot() {
      return queue.skippedSinceBoot;
    },
    get lastSkippedAt() {
      return queue.lastSkippedAt;
    },
  };

  // Integrations: clear stale in-flight, load manifests, build registry +
  // captures, seed scheduler cursors, start gateways.
  await resetInFlightFlags(dbHandle);
  const integrationsDir = new URL('../../io/integrations/', import.meta.url).pathname;
  const { loaded: manifests, unavailable } = await loadManifests(integrationsDir);
  for (const u of unavailable) {
    console.warn(`[daemon] integration ${u.name} unavailable: ${u.error}`);
  }
  const registry = new Map();
  const gatewayClients = new Map();
  for (const m of manifests) {
    const capture = createCapture({
      db: dbHandle,
      embedder: embedderWrap,
      source: m.name,
      embed: m.embed,
      mode: m.capture_mode,
    });
    registry.set(m.name, { ...m, capture });

    if (m.cadence_ms !== null && m.sync) {
      // Sync integration: seed scheduler cursor.
      const [rows] = await dbHandle
        .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
        .collect();
      const value = rows[0]?.value ?? {};
      const integrations = value.integrations ?? {};
      if (!integrations[m.name]) {
        integrations[m.name] = {
          cadence_ms: m.cadence_ms,
          next_run_at: new Date(),
          consecutive_failures: 0,
        };
        await dbHandle
          .query(
            surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, integrations }}`,
          )
          .collect();
      }
    } else if (m.cadence_ms === null && m.start) {
      // Gateway integration: boot via start fn.
      try {
        const ctx = {
          db: dbHandle,
          host: _host,
          log: (...a) => console.log(`[${m.name}]`, ...a),
          capture,
        };
        const client = await m.start(ctx);
        gatewayClients.set(m.name, client);
        console.log(`integration ${m.name}: gateway started`);
      } catch (e) {
        console.warn(`integration ${m.name}: gateway start failed: ${e.message}`);
      }
    } else if (m.cadence_ms === null && !m.start && (m.tools?.length ?? 0) > 0) {
      console.log(`integration ${m.name}: tool-only (no sync, no gateway)`);
    } else {
      console.warn(`integration ${m.name}: invalid kind (no sync, start, or tools)`);
    }
  }

  // Seed dream cursor (next 4 am) once at boot if absent.
  {
    const [rows] = await dbHandle
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const value = rows[0]?.value ?? {};
    if (!value.dream?.next_run_at) {
      const next = new Date();
      next.setHours(4, 0, 0, 0);
      if (next <= new Date()) next.setDate(next.getDate() + 1);
      const dream = { ...(value.dream ?? {}), next_run_at: next };
      await dbHandle
        .query(
          surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, dream }}`,
        )
        .collect();
    }
  }

  // Jobs cache (built-in + user) — discover, UPSERT into runtime_jobs, plan.
  const jobsCache = { current: [] };
  const refreshJobs = async () => {
    const userJobsDir = join(paths.data.home(), 'jobs');
    jobsCache.current = discoverJobs({ builtinDir: BUILTIN_JOBS_DIR, userDir: userJobsDir });
    await upsertFromDiscovered(dbHandle, jobsCache.current);
    await garbageCollect(dbHandle, new Set(jobsCache.current.map((j) => j.name)));
    await planNextRunAt(dbHandle, jobsCache.current);
  };
  await refreshJobs();

  const captureForJobs = createCapture({
    db: dbHandle,
    embedder: embedderWrap,
    source: 'job_output',
    embed: false,
    mode: 'insert-or-skip',
  });

  const ctx = {
    version,
    startedAt,
    db: dbHandle,
    embedder: { idle: idleEmbedder, wrap: embedderWrap },
    detector,
    queue: queueWrap,
    sessions: { count: 0 },
    manifests,
    registry,
    gatewayClients,
    jobs: { cache: jobsCache, refresh: refreshJobs },
    capture: { forJobs: captureForJobs },
    get host() {
      return _host;
    },
    setHost(h) {
      _host = h;
    },
    log: console.log,
    closeDb: () => close(dbHandle).catch(() => {}),
  };
  _ctxRef = ctx;
  return ctx;
}
