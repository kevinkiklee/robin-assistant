import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { surql } from 'surrealdb';
import { biographerProcess } from '../../cognition/biographer/pipeline.js';
import { createBiographerQueue } from '../../cognition/biographer/queue.js';
import { dreamProcess } from '../../cognition/dream/pipeline.js';
import { resetActionTrust, setActionTrust } from '../../cognition/jobs/action-trust.js';
import { synthesizeCommStyle } from '../../cognition/jobs/comm-style.js';
import { garbageCollect, getJob, upsertFromDiscovered } from '../../cognition/jobs/db.js';
import { discoverJobs } from '../../cognition/jobs/loader.js';
import {
  computeCalibration,
  resolvePrediction,
  setCalibration,
} from '../../cognition/jobs/predictions.js';
import { runOneJob } from '../../cognition/jobs/runner.js';
import { listDueJobs, planNextRunAt } from '../../cognition/jobs/scheduler-ext.js';
import { ensureHome, paths } from '../../config/data-store.js';
import { readConfig } from '../../config/paths.js';
import { envFilePath } from '../../config/secrets.js';
import { close, connect, defaultDbUrl } from '../../data/db/client.js';
import { createEmbedder } from '../../data/embed/factory.js';
import { resetInFlightFlags } from '../../io/integrations/_framework/boot-cleanup.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { loadManifests } from '../../io/integrations/_framework/manifest-loader.js';
import { runIntegrationSync } from '../../io/integrations/_framework/run-sync.js';
import { createRepeatQueryDetector } from '../../io/mcp/implicit-signals.js';
import { createArchiveHistoryTool } from '../../io/mcp/tools/archive-history.js';
import { createAuditTool } from '../../io/mcp/tools/audit.js';
import { createCheckActionTool } from '../../io/mcp/tools/check-action.js';
import { createEndorseTool } from '../../io/mcp/tools/endorse.js';
import { createExplainActionTrustTool } from '../../io/mcp/tools/explain-action-trust.js';
import { createExplainBeliefTool } from '../../io/mcp/tools/explain-belief.js';
import { createExplainRecallTool } from '../../io/mcp/tools/explain-recall.js';
import { createFindEntityTool } from '../../io/mcp/tools/find-entity.js';
import { createGetArcTool } from '../../io/mcp/tools/get-arc.js';
import { createGetCommStyleTool } from '../../io/mcp/tools/get-comm-style.js';
import { createGetEntityTool } from '../../io/mcp/tools/get-entity.js';
import { createGetHotTool } from '../../io/mcp/tools/get-hot.js';
import { createGetKnowledgeTool } from '../../io/mcp/tools/get-knowledge.js';
import { createGetProfileTool } from '../../io/mcp/tools/get-profile.js';
import { createHealthTool } from '../../io/mcp/tools/health.js';
import { createIngestTool } from '../../io/mcp/tools/ingest.js';
import { createIntegrationRunTool } from '../../io/mcp/tools/integration-run.js';
import { createIntegrationStatusTool } from '../../io/mcp/tools/integration-status.js';
import { createLintTool } from '../../io/mcp/tools/lint.js';
import { createListArcsTool } from '../../io/mcp/tools/list-arcs.js';
import { createListEpisodesTool } from '../../io/mcp/tools/list-episodes.js';
import { createListJobsTool } from '../../io/mcp/tools/list-jobs.js';
import { createListJournalTool } from '../../io/mcp/tools/list-journal.js';
import { createListOpenPredictionsTool } from '../../io/mcp/tools/list-open-predictions.js';
import { createListPatternsTool } from '../../io/mcp/tools/list-patterns.js';
import { createListRulesTool } from '../../io/mcp/tools/list-rules.js';
import { createPredictTool } from '../../io/mcp/tools/predict.js';
import { createRecallTool } from '../../io/mcp/tools/recall.js';
import { createRecentRefusalsTool } from '../../io/mcp/tools/recent-refusals.js';
import { createRecordCorrectionTool } from '../../io/mcp/tools/record-correction.js';
import { createRefuteTool } from '../../io/mcp/tools/refute.js';
import { createRelatedEntitiesTool } from '../../io/mcp/tools/related-entities.js';
import { createRememberTool } from '../../io/mcp/tools/remember.js';
import { createResolvePredictionTool } from '../../io/mcp/tools/resolve-prediction.js';
import { createRunBiographerTool } from '../../io/mcp/tools/run-biographer.js';
import { createRunDreamTool } from '../../io/mcp/tools/run-dream.js';
import { createRunJobTool } from '../../io/mcp/tools/run-job.js';
import { createShowPendingTriggersTool } from '../../io/mcp/tools/show-pending-triggers.js';
import { createShowStepHealthTool } from '../../io/mcp/tools/show-step-health.js';
import { createUpdateActionPolicyTool } from '../../io/mcp/tools/update-action-policy.js';
import { createUpdateRuleTool } from '../../io/mcp/tools/update-rule.js';
import { detectHost } from '../hosts/detect.js';
import { createScheduler } from './heartbeat.js';
import { createIdleEmbedder } from './idle-embedder.js';
import { runIntrospection } from './introspection.js';
import { acquireDaemonLock, releaseDaemonLock } from './lock.js';
import { bindFreePort } from './port.js';
import { endSession, listActiveSessions, markStaleSessions, registerSession } from './sessions.js';
import { clearDaemonState, writeDaemonState } from '../../config/daemon-state.js';
import { getCliVersion } from './version-handshake.js';

const BUILTIN_JOBS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'jobs', 'builtin');

export async function startDaemon() {
  const version = await getCliVersion();
  await ensureHome();
  if (!existsSync(envFilePath())) {
    console.warn(`[daemon] no secrets file at ${envFilePath()} — integrations will fail.`);
    console.warn(
      '         Run: robin secrets import --from <v1-user-data>  (or: robin secrets set <KEY>)',
    );
  }
  const lockPath = paths.data.daemonLock();
  const statePath = paths.data.daemonState();

  await acquireDaemonLock(lockPath);

  const startedAt = new Date();
  let dbHandle = null;
  let httpServer = null;
  let scheduler = null;
  let sessionSweeper = null;
  let shuttingDown = false;
  const gatewayClients = new Map();
  const registry = new Map();

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal) console.log(`daemon: received ${signal}, shutting down`);
    if (sessionSweeper) clearInterval(sessionSweeper);
    if (scheduler) {
      console.log('scheduler stopping (in-flight dream may continue briefly)');
      scheduler.stop();
    }
    const grace = setTimeout(() => {
      console.warn('daemon: shutdown grace expired, forcing exit');
      process.exit(1);
    }, 10_000);
    grace.unref?.();
    for (const [name, client] of gatewayClients) {
      const m = registry.get(name);
      if (m?.stop) {
        try {
          await m.stop({ log: console.log }, client);
          console.log(`integration ${name}: stopped`);
        } catch (e) {
          console.warn(`integration ${name}: stop failed: ${e.message}`);
        }
      }
    }
    if (httpServer) httpServer.close();
    if (dbHandle) await close(dbHandle).catch(() => {});
    await clearDaemonState(statePath).catch(() => {});
    await releaseDaemonLock(lockPath).catch(() => {});
    clearTimeout(grace);
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').finally(() => process.exit(0));
  });

  try {
    dbHandle = await connect({ engine: await defaultDbUrl() });

    // Profile-drift detection. config.json is filesystem state; runtime:embedder
    // is set by whichever 0008-embedder-<profile>.surql migration last ran.
    // If a user hand-edits config.json without running `robin embedder switch`,
    // the HNSW index dimension and the new embedder dim disagree — first insert
    // would fail an array-length assertion. Refuse to start with explicit
    // remediation steps instead.
    const cfg = await readConfig();
    if (!cfg?.embedder_profile) {
      console.error('[daemon] no embedder profile configured. Run `robin install` first.');
      process.exit(1);
    }
    {
      const [rows] = await dbHandle
        .query(surql`SELECT * FROM type::record('runtime', 'embedder')`)
        .collect();
      const runtimeProfile = rows?.[0]?.value?.profile;
      if (runtimeProfile && runtimeProfile !== cfg.embedder_profile) {
        console.error(
          `[daemon] config drift detected:\n  config.json says: ${cfg.embedder_profile}\n  runtime:embedder says: ${runtimeProfile}\nRun \`robin embedder switch ${cfg.embedder_profile}\` to migrate the schema, or revert config.json.`,
        );
        process.exit(1);
      }
    }

    const idleEmbedder = createIdleEmbedder({
      factory: createEmbedder,
      idleMs: 600_000,
    });

    // Embedder health check. The IdleEmbedder wrapper is just a lifecycle
    // shell; .get() lazily resolves the inner embedder via createEmbedder().
    // Each profile's healthCheck is cheap: mxbai is a no-op, qwen3 hits
    // /api/tags, gemini just verifies GEMINI_API_KEY is set. On failure print
    // profile-specific guidance and exit.
    try {
      const embedder = await idleEmbedder.get();
      await embedder.healthCheck();
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
      process.exit(1);
    }
    // Daemon-boot introspection. Result persists to runtime_introspection_state;
    // SessionStart hook reads it without recomputing. Fail-soft: errors here
    // do not block daemon boot — they surface as a finding row.
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

    // Eagerly resolve the host so the scheduler + run_dream tool can use a
    // stable reference. If detection throws (no host CLI on PATH and no
    // ROBIN_HOST override), keep `host` null and fall back to the original
    // lazy-detect path inside the biographer worker — that preserves Phase
    // 2b semantics where a daemon without a host CLI still boots fine for
    // recall/remember tools.
    let host = null;
    try {
      host = await detectHost();
    } catch (e) {
      console.warn(
        `[daemon] no host detected at startup: ${e.message}; scheduler disabled, run_dream will fail until a host is available`,
      );
    }
    async function getHost() {
      if (!host) host = await detectHost();
      return host;
    }
    const queue = createBiographerQueue({
      worker: async (eventId) => {
        const e = await idleEmbedder.get();
        const h = await getHost();
        await biographerProcess(dbHandle, e, h, eventId);
      },
      dedupe: true,
    });
    let lastBiographerRunAt = null;
    const queueWrap = {
      enqueue: (id) => {
        const ret = queue.enqueue(id);
        // Queue may return { skipped: true } when at maxPending cap — not a promise.
        // Wrap it as a resolved promise so callers' .catch() / .then() chains
        // continue to work transparently.
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
    const detector = createRepeatQueryDetector({});

    const sessions = { count: 0 };
    const dbWrap = {
      isOpen: () => true,
      query: (...a) => dbHandle.query(...a),
    };
    const embedderWrap = {
      isLoaded: () => false,
      embed: async (text) => (await idleEmbedder.get()).embed(text),
    };

    // Boot integrations: clear stale in_flight flags, load manifests, build
    // registry entries with secrets + per-integration capture helper, seed
    // scheduler cursor rows for scheduled syncs, and boot gateway integrations.
    await resetInFlightFlags(dbHandle);

    const integrationsDir = new URL('../integrations/', import.meta.url).pathname;
    const { loaded: manifests, unavailable } = await loadManifests(integrationsDir);
    if (unavailable.length > 0) {
      for (const u of unavailable) {
        console.warn(`[daemon] integration ${u.name} unavailable: ${u.error}`);
      }
    }

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
        // (Note: dream cursor is seeded once below after the loop.)
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
        // Secrets are pulled directly from dotenv inside the integration's
        // start fn (e.g. discord), so the daemon no longer needs to fetch
        // them ahead of time. A missing required secret throws inside start
        // and we log + continue.
        try {
          const ctx = {
            db: dbHandle,
            host,
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
        // Tool-only integration: no scheduler cursor, no gateway boot. Tools
        // register below; the integration is invoked exclusively via MCP.
        console.log(`integration ${m.name}: tool-only (no sync, no gateway)`);
      } else {
        console.warn(`integration ${m.name}: invalid kind (no sync, start, or tools)`);
      }
    }

    // Seed dream cursor (next 4am) once at boot if absent.
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

    // Phase 4d — discover jobs (built-in + user) and UPSERT into runtime_jobs.
    const jobsCache = { current: [] };
    const refreshJobs = async () => {
      const userJobsDir = join(paths.data.home(), 'jobs');
      jobsCache.current = discoverJobs({
        builtinDir: BUILTIN_JOBS_DIR,
        userDir: userJobsDir,
      });
      await upsertFromDiscovered(dbHandle, jobsCache.current);
      await garbageCollect(dbHandle, new Set(jobsCache.current.map((j) => j.name)));
      await planNextRunAt(dbHandle, jobsCache.current);
    };
    await refreshJobs();

    const tools = [
      createHealthTool({
        version,
        startedAt,
        db: dbWrap,
        embedder: embedderWrap,
        biographerQueue: queueWrap,
        sessions,
      }),
      createRecallTool({
        db: dbHandle,
        embedder: embedderWrap,
        detector,
        getSessionId: () => null,
      }),
      createRememberTool({ db: dbHandle, embedder: embedderWrap, queue: queueWrap }),
      createRunBiographerTool({ db: dbHandle, processor: queueWrap.enqueue }),
      createFindEntityTool({ db: dbHandle, embedder: embedderWrap }),
      createGetEntityTool({ db: dbHandle }),
      createRelatedEntitiesTool({ db: dbHandle }),
      createListEpisodesTool({ db: dbHandle }),
      createRecordCorrectionTool({
        db: dbHandle,
        embedder: embedderWrap,
        processor: queueWrap.enqueue,
      }),
      // Phase 2c read/update tools
      createGetKnowledgeTool({ db: dbHandle, embedder: embedderWrap }),
      createListPatternsTool({ db: dbHandle }),
      createGetProfileTool({ db: dbHandle }),
      createListJournalTool({ db: dbHandle }),
      createGetHotTool({ db: dbHandle }),
      createListRulesTool({ db: dbHandle }),
      createUpdateRuleTool({ db: dbHandle }),
      createRunDreamTool({
        db: dbHandle,
        host,
        embedder: embedderWrap,
        dreamProcess,
      }),
    ];

    // Integration MCP tools: status + manual run + per-manifest factories.
    tools.push(createIntegrationStatusTool({ db: dbHandle }));
    tools.push(createIntegrationRunTool({ db: dbHandle, registry, runIntegrationSync }));
    const getGatewayClient = (name) => gatewayClients.get(name) ?? null;
    for (const m of manifests) {
      for (const factory of m.tools ?? []) {
        try {
          const reg = registry.get(m.name);
          const tool = factory({
            db: dbHandle,
            embedder: embedderWrap,
            capture: reg?.capture,
            getGatewayClient,
          });
          tools.push(tool);
        } catch (e) {
          console.warn(`integration ${m.name}: tool factory failed: ${e.message}`);
        }
      }
    }

    // Phase 4d — job runner MCP tools.
    const captureForJobs = createCapture({
      db: dbHandle,
      embedder: embedderWrap,
      source: 'job_output',
      embed: false,
      mode: 'insert-or-skip',
    });
    tools.push(createListJobsTool({ db: dbHandle }));
    tools.push(
      createRunJobTool({
        db: dbHandle,
        capture: captureForJobs,
        host,
        tools: () => tools,
        getJobs: () => jobsCache.current,
      }),
    );
    tools.push(createIngestTool({ db: dbHandle, embedder: embedderWrap, host }));
    tools.push(createLintTool({ db: dbHandle }));
    tools.push(createAuditTool({ db: dbHandle, host }));
    tools.push(createCheckActionTool({ db: dbHandle }));
    tools.push(createUpdateActionPolicyTool({ db: dbHandle }));
    tools.push(createGetCommStyleTool({ db: dbHandle }));
    tools.push(createPredictTool({ db: dbHandle }));
    tools.push(createResolvePredictionTool({ db: dbHandle }));
    tools.push(createListOpenPredictionsTool({ db: dbHandle }));
    tools.push(createEndorseTool({ db: dbHandle }));
    tools.push(createRefuteTool({ db: dbHandle }));
    tools.push(createListArcsTool({ db: dbHandle }));
    tools.push(createGetArcTool({ db: dbHandle }));
    tools.push(createExplainRecallTool({ db: dbHandle }));
    tools.push(createExplainBeliefTool({ db: dbHandle }));
    tools.push(createExplainActionTrustTool({ db: dbHandle }));
    tools.push(createShowPendingTriggersTool({ db: dbHandle }));
    tools.push(createShowStepHealthTool({ db: dbHandle }));
    tools.push(createRecentRefusalsTool({ db: dbHandle }));
    tools.push(createArchiveHistoryTool({ db: dbHandle }));

    // Heartbeat scheduler: surveys due integrations + dream cursor each tick,
    // dispatches via runOne. Falls back to dream when nothing is due and the
    // un-biographed event queue overflows. Skipped without a host since dream
    // and biographer both need one.
    if (host) {
      const baseListDue = async () => {
        const due = [];
        const [rows] = await dbHandle
          .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
          .collect();
        const value = rows[0]?.value ?? {};
        const integrations = value.integrations ?? {};
        const now = new Date();
        for (const [name, row] of Object.entries(integrations)) {
          if (!row?.next_run_at) continue;
          if (new Date(row.next_run_at) <= now && !row.in_flight) {
            due.push({ name, kind: 'integration' });
          }
        }
        const dreamCursor = value.dream;
        if (dreamCursor?.next_run_at && new Date(dreamCursor.next_run_at) <= now) {
          due.push({ name: '__dream__', kind: 'dream' });
        }
        // embed_backfill is always-due if any event is missing an embedding
        // row in the active profile's events surface.
        try {
          const { activeProfile, embeddingTable } = await import(
            '../../data/embed/profile-router.js'
          );
          const profile = await activeProfile(dbHandle);
          const eventsEmbTbl = embeddingTable(profile, 'events');
          const [pending] = await dbHandle
            .query(
              `SELECT count() AS n FROM events
               WHERE meta.embed_failed IS NOT true
                 AND id NOT IN (SELECT VALUE record FROM ${eventsEmbTbl})
               GROUP ALL`,
            )
            .collect();
          if ((pending[0]?.n ?? 0) > 0) {
            due.push({ name: '__embed_backfill__', kind: 'embed_backfill' });
          }
        } catch {
          // No active profile yet (fresh DB) — backfill simply isn't due.
        }
        return due;
      };
      const baseRunOne = async (name) => {
        if (name === '__embed_backfill__') {
          const e = await idleEmbedder.get();
          const { embedBackfillTick } = await import('../../data/embed/backfill.js');
          return await embedBackfillTick({
            db: dbHandle,
            embedder: e,
            batch: 64,
            log: console.log,
          });
        }
        if (name === '__dream__') {
          const e = await idleEmbedder.get();
          const h = await getHost();
          try {
            return await dreamProcess(dbHandle, h, e);
          } finally {
            const next = new Date();
            next.setHours(4, 0, 0, 0);
            if (next <= new Date()) next.setDate(next.getDate() + 1);
            const [rows] = await dbHandle
              .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
              .collect();
            const value = rows[0]?.value ?? {};
            const dream = { ...(value.dream ?? {}), next_run_at: next, last_run_at: new Date() };
            await dbHandle
              .query(
                surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, dream }}`,
              )
              .collect();
          }
        }
        return await runIntegrationSync(dbHandle, registry, name);
      };
      scheduler = createScheduler({
        listDue: async () => {
          // Refresh jobs from disk so drop-in markdown is picked up.
          await refreshJobs();
          const baseDue = await baseListDue();
          const jobsDue = await listDueJobs(dbHandle, new Date());
          return [...baseDue, ...jobsDue]; // integrations + dream first, then jobs
        },
        runOne: async (name) => {
          const job = jobsCache.current.find((j) => j.name === name);
          if (job) {
            await runOneJob({
              db: dbHandle,
              capture: captureForJobs,
              host,
              jobs: jobsCache.current,
              tools,
              name,
            });
            await planNextRunAt(dbHandle, jobsCache.current);
            return;
          }
          return baseRunOne(name);
        },
        isOverflow: async () => {
          const [rows] = await dbHandle
            .query(surql`SELECT count() AS n FROM events WHERE biographed_at IS NONE GROUP ALL`)
            .collect();
          return (rows[0]?.n ?? 0) >= 500;
        },
      });
      scheduler.start();
    }

    // Theme 3: cadence consumer. Drains dream_triggers each minute.
    let cadenceTicker = null;
    if (host) {
      const { consumePendingTriggers } = await import('./cadence-consumer.js');
      cadenceTicker = setInterval(() => {
        consumePendingTriggers(dbHandle, host).catch((e) => {
          console.warn(`[cadence-consumer] ${e.message}`);
        });
      }, 60_000);
      cadenceTicker.unref?.();
    }

    // Theme 1b: stale-episode sweeper. Every 10 minutes — episodes with
    // last_event_at past per-source idle threshold get ended_at.
    let staleEpisodeTicker = null;
    {
      const { closeStaleEpisodes } = await import(
        '../../cognition/jobs/internal/close-stale-episodes.js'
      );
      staleEpisodeTicker = setInterval(() => {
        closeStaleEpisodes(dbHandle).catch((e) => {
          console.warn(`[close-stale-episodes] ${e.message}`);
        });
      }, 600_000);
      staleEpisodeTicker.unref?.();
    }

    // Theme 2b: action-trust decay sweep. Every 6h — AUTO classes unused
    // for decay_days get demoted to ASK.
    let actionTrustDecayTicker = null;
    {
      const { runActionTrustDecay } = await import('../../cognition/jobs/action-trust.js');
      actionTrustDecayTicker = setInterval(
        () => {
          runActionTrustDecay(dbHandle).catch((e) => {
            console.warn(`[action-trust-decay] ${e.message}`);
          });
        },
        6 * 60 * 60_000,
      );
      actionTrustDecayTicker.unref?.();
    }

    const { server: probe, port } = await bindFreePort();
    probe.close();

    async function readJsonBody(req) {
      return await new Promise((resolveBody) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (!raw) return resolveBody({});
          try {
            resolveBody(JSON.parse(raw));
          } catch {
            resolveBody({});
          }
        });
        req.on('error', () => resolveBody({}));
      });
    }

    httpServer = createServer(async (req, res) => {
      try {
        if (req.method === 'POST' && req.url === '/internal/biographer/process-pending') {
          const body = await readJsonBody(req);
          // Capture pre-step (fail-soft). When the Stop hook forwards
          // transcript_path, read the latest turn and write a conversation
          // event before draining pending — biographer then processes it
          // alongside any other pending rows.
          if (body && typeof body.transcript_path === 'string' && body.transcript_path.length > 0) {
            try {
              const { captureFromTranscript } = await import('../../io/capture/session-capture.js');
              await captureFromTranscript(dbHandle, embedderWrap, {
                transcriptPath: body.transcript_path,
                sessionId: body.session_id ?? body.sessionId ?? null,
                host: host?.name ?? null,
              });
            } catch (e) {
              console.error(`daemon capture pre-step failed: ${e.message}`);
            }
          }

          const [pendingRows] = await dbHandle
            .query('SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50')
            .collect();
          for (const row of pendingRows) {
            queueWrap.enqueue(String(row.id)).catch(() => {
              // queueWrap already logs; swallow here to keep loop going.
            });
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ enqueued: pendingRows.length }));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/remember') {
          const body = await readJsonBody(req);
          if (typeof body.content !== 'string' || body.content.length === 0) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'content required' }));
            return;
          }
          try {
            const { recordEvent } = await import('../../io/capture/record-event.js');
            const { guardInboundContent } = await import(
              '../../cognition/discretion/inbound-guard.js'
            );
            const result = await recordEvent(dbHandle, embedderWrap, {
              source: body.source ?? 'cli',
              content: body.content,
              meta: body.meta ?? undefined,
              guard: body.force === true ? undefined : guardInboundContent,
            });
            queueWrap.enqueue(String(result.id)).catch(() => {
              // queueWrap already logs.
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: String(result.id) }));
          } catch (e) {
            const code = e?.name === 'RobinPiiRefusedError' ? 422 : 500;
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: e.message, name: e?.name }));
          }
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/session/register') {
          const body = await readJsonBody(req);
          await markStaleSessions(dbHandle).catch(() => {});
          await registerSession(dbHandle, {
            sessionId: body.session_id ?? body.sessionId ?? `pid-${body.pid ?? 'unknown'}`,
            host: body.host ?? 'unknown',
            pid: typeof body.pid === 'number' ? body.pid : null,
            transcriptPath: body.transcript_path ?? body.transcriptPath ?? null,
          });
          const active = await listActiveSessions(dbHandle);
          let introspection_findings = [];
          try {
            const [rows] = await dbHandle
              .query("SELECT * FROM type::record('runtime_introspection_state', 'current')")
              .collect();
            introspection_findings = rows?.[0]?.findings ?? [];
          } catch {
            introspection_findings = [];
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ session_count: active.length, introspection_findings }));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/session/end') {
          const body = await readJsonBody(req);
          await endSession(
            dbHandle,
            body.session_id ?? body.sessionId ?? `pid-${body.pid ?? 'unknown'}`,
          );
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/jobs/run') {
          const body = await readJsonBody(req);
          const name = body?.name;
          const force = body?.force === true;
          if (!name) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'missing name' }));
            return;
          }
          const row = await getJob(dbHandle, name);
          if (!row) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'job not found' }));
            return;
          }
          if (row.in_flight && !force) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'in_flight' }));
            return;
          }
          if (row.manually_runnable === false && !force) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'not_manually_runnable' }));
            return;
          }
          await runOneJob({
            db: dbHandle,
            capture: captureForJobs,
            host,
            jobs: jobsCache.current,
            tools,
            name,
          });
          await planNextRunAt(dbHandle, jobsCache.current);
          const after = await getJob(dbHandle, name);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: after.last_run_ok === true,
              last_error: after.last_error ?? null,
            }),
          );
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/jobs/reload') {
          await refreshJobs();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: jobsCache.current.length }));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/knowledge/ingest') {
          const body = await readJsonBody(req);
          const tool = tools.find((t) => t.name === 'ingest');
          if (!tool) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'ingest_tool_not_registered' }));
            return;
          }
          const result = await tool.handler(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/knowledge/lint') {
          const body = await readJsonBody(req);
          const tool = tools.find((t) => t.name === 'lint');
          if (!tool) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'lint_tool_not_registered' }));
            return;
          }
          const result = await tool.handler(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/knowledge/audit') {
          const body = await readJsonBody(req);
          const tool = tools.find((t) => t.name === 'audit');
          if (!tool) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'audit_tool_not_registered' }));
            return;
          }
          const result = await tool.handler(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/actions/set') {
          const body = await readJsonBody(req);
          if (!body?.class || !['AUTO', 'ASK', 'NEVER'].includes(body?.state)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'invalid_input' }));
            return;
          }
          await setActionTrust(dbHandle, body.class, body.state, 'user');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, class: body.class, state: body.state }));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/actions/reset') {
          const body = await readJsonBody(req);
          if (!body?.class) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'missing_class' }));
            return;
          }
          await resetActionTrust(dbHandle, body.class);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, class: body.class, state: 'ASK' }));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/comm-style/refresh') {
          const result = await synthesizeCommStyle(dbHandle, host);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/predictions/resolve') {
          const body = await readJsonBody(req);
          const result = await resolvePrediction(dbHandle, body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/calibration/refresh') {
          const c = await computeCalibration(dbHandle);
          await setCalibration(dbHandle, c);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(c));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/embeddings/op') {
          const body = await readJsonBody(req);
          const { dispatch: dispatchEmbeddingsOp } = await import(
            '../../cognition/jobs/embeddings-ops.js'
          );
          const result = await dispatchEmbeddingsOp(dbHandle, body);
          res.writeHead(result?.ok ? 200 : 400, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/intuition') {
          const body = await readJsonBody(req);
          const { intuitionEndpoint } = await import('../../cognition/intuition/inject.js').catch(
            () => ({}),
          );
          if (typeof intuitionEndpoint === 'function') {
            const result = await intuitionEndpoint({
              db: dbHandle,
              embedder: embedderWrap,
              detector,
              query: body.query ?? '',
              priorAssistant: body.prior_assistant ?? body.priorAssistant ?? '',
              k: body.k ?? 6,
              recencyDays: body.recency_days ?? body.recencyDays ?? 30,
              tokenBudget: body.token_budget ?? body.tokenBudget ?? 1500,
            }).catch(() => ({ block: '', hits: 0, tokens: 0, latency_ms: 0 }));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ block: '', hits: 0, tokens: 0, latency_ms: 0 }));
          return;
        }
        if (req.method === 'GET' && req.url.startsWith('/sse')) {
          sessions.count++;
          const transport = new SSEServerTransport('/messages', res);
          const mcpServer = new Server({ name: 'robin', version }, { capabilities: { tools: {} } });
          mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          }));
          mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const tool = tools.find((t) => t.name === name);
            if (!tool) {
              return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
            }
            try {
              const result = await tool.handler(args ?? {});
              return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            } catch (e) {
              return { isError: true, content: [{ type: 'text', text: e.message }] };
            }
          });
          await mcpServer.connect(transport);
          req.on('close', () => {
            sessions.count = Math.max(0, sessions.count - 1);
          });
          return;
        }
        res.writeHead(404).end();
      } catch (e) {
        try {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        } catch {
          /* response already sent */
        }
      }
    });
    httpServer.listen(port, '127.0.0.1');

    await writeDaemonState(statePath, {
      port,
      pid: process.pid,
      version,
      started_at: startedAt.toISOString(),
      tool_count: tools.length,
    });

    // Stale-session sweeper: every 60s mark sessions whose last_seen_at is
    // older than 5 minutes as 'stale'. Cleanup-only — purge is opt-in via CLI.
    sessionSweeper = setInterval(() => {
      markStaleSessions(dbHandle).catch(() => {});
    }, 60_000);
    sessionSweeper.unref?.();

    console.log(`robin-mcp daemon ready on 127.0.0.1:${port}`);

    await new Promise(() => {});
  } catch (e) {
    console.error(`daemon failed: ${e.message}`);
    await shutdown();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDaemon();
}
