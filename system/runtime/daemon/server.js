import { ensureMcpToken } from '../../config/mcp-token.js';
import { startIntrospection, stopIntrospection } from '../../cognition/introspection/index.js';
import { createTriggerEngine } from '../../cognition/triggers/engine.js';
import { createTriggerTick } from '../../cognition/triggers/loop.js';
import { recordEvent } from '../../io/capture/record-event.js';
import { loadAllowlist } from '../../io/integrations/imessage/allowlist.js';
import { openChatDb, pollOnce as imessagePollOnce } from '../../io/integrations/imessage/inbox.js';
import { runActionTrustDecay } from '../../cognition/jobs/action-trust.js';
import { closeStaleEpisodes } from '../../cognition/jobs/internal/close-stale-episodes.js';
import {
  evaluateStateInference,
  readStateInferenceConfig,
} from '../../cognition/jobs/internal/state-inference.js';
import { runCostMonitor } from '../../cognition/jobs/cost-monitor.js';
import { resolveDuePredictions } from '../../cognition/jobs/resolve-due-predictions.js';
import { runTaskOutcomeDriftWatchdog } from '../../cognition/jobs/task-outcome-drift-watchdog.js';
import { withRuntimeJobsTracking } from '../../cognition/jobs/scheduler-ext.js';
import { paths } from '../../config/data-store.js';
import { readConfig } from '../../config/paths.js';
import { detectHost } from '../hosts/detect.js';
import { createInvariantsTick, runBootInvariants } from '../invariants/daemon-tick.js';
import { boot } from './boot.js';
import { consumePendingTriggers } from './cadence-consumer.js';
import { createDispatcherTick } from './dispatcher-tick.js';
import { createScheduler } from './heartbeat.js';
import { startHttp } from './http.js';
import { installLogScrub } from './log-scrub.js';
import { startJobHotReload } from './job-hot-reload.js';
import { createLifecycle } from './lifecycle.js';
import { bindPort } from './port.js';
import { buildRoutes } from './routes/index.js';
import { markStaleSessions } from './sessions.js';
import { buildTools } from './tools.js';

/**
 * The daemon's thin compose. Each subsystem owns its own concerns:
 *
 *   lifecycle.js     lock, shutdown, fatal handlers, state file, signals
 *   boot.js          DB, embedder, introspection, host, integrations, jobs
 *   tools.js         pure ctx → MCP Tool[]
 *   routes/          per-domain /internal/* route table
 *   http.js          route dispatcher + 404 + 500 + /sse special case
 *   mcp-sse.js       SSE transport wiring
 *   heartbeat.js     bucket-based scheduler
 *   dispatcher-tick.js  the 'dispatcher' bucket's tick body
 */
export async function startDaemon() {
  // Patch stdout/stderr before anything logs — covers integration syncs,
  // SurrealDB native binding errors, stack traces, and any third-party
  // module that writes to the streams directly.
  installLogScrub();
  const lifecycle = createLifecycle({
    // Process-singleton lock — distinct from `runtime/daemon/.lock`, which is
    // the embedded-DB writer-serialization lock held by CLI subcommands.
    // Sharing one file made every long-running biographer/dream/ingest run
    // block `mcp restart`; see data-store.js for the file-role split.
    lockPath: paths.data.daemonPid(),
    statePath: paths.data.daemonState(),
    logDir: `${paths.data.home()}/logs`,
  });
  await lifecycle.acquireLock();

  try {
    const ctx = await boot();
    const tools = await buildTools(ctx);
    const routes = buildRoutes();
    // Preferred-port: read once from config.json so launchd restarts keep
    // the same port, which keeps `~/.claude.json` (and Gemini's settings.json)
    // pointed at a valid URL across daemon lifecycles. Falls back to an
    // ephemeral port if the preferred one is busy.
    const cfgForPort = await readConfig().catch(() => null);
    const preferredPort = Number.isInteger(cfgForPort?.mcp?.port) ? cfgForPort.mcp.port : 0;
    const { server: probe, port } = await bindPort(preferredPort);
    probe.close();

    // Ensure the MCP bearer token exists before invariants run — the
    // wiring invariant embeds it in .mcp.json's headers, so it must be
    // readable before the first boot-invariants pass.
    const authToken = ensureMcpToken();

    const dispatcherTick = createDispatcherTick(ctx, tools);

    // M1 trigger engine — empty registration in this commit; M3 adds the
    // user-data/triggers/*.yaml loader and the JS-builtin registration hook.
    // The tick early-exits when no triggers are registered, so the substrate
    // is dormant until something gets registered. Kill switch:
    // ROBIN_DISABLE_TRIGGERS=1 (gate inline on the bucket).
    const triggerEngine = createTriggerEngine({ logger: console });
    const triggerDispatch = async (toolName, args /* , opts */) => {
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) throw new Error(`trigger dispatch: unknown tool ${toolName}`);
      return tool.handler(args ?? {});
    };
    const triggerTick = createTriggerTick({
      db: ctx.db,
      engine: triggerEngine,
      dispatchTool: triggerDispatch,
      logger: console,
    });

    // M2 iMessage inbox — opt-in via ROBIN_IMESSAGE_ENABLED=1 (macOS only).
    // chat.db needs Full Disk Access TCC grant. Allowlist file path defaults
    // to <user-data>/io/integrations/imessage/allowlist.txt; override via
    // ROBIN_IMESSAGE_ALLOWLIST. Cursor lives in runtime:imessage_cursor.
    let imessageDb = null;
    let imessageAllowlist = { directHandles: new Set(), groupChats: new Set() };
    if (process.env.ROBIN_IMESSAGE_ENABLED === '1' && process.platform === 'darwin') {
      try {
        imessageDb = openChatDb();
        const allowPath =
          process.env.ROBIN_IMESSAGE_ALLOWLIST ||
          `${paths.data.home()}/io/integrations/imessage/allowlist.txt`;
        imessageAllowlist = loadAllowlist(allowPath);
        console.log(
          `[imessage] enabled — allowlist: ${imessageAllowlist.directHandles.size} DMs, ${imessageAllowlist.groupChats.size} groups`,
        );
      } catch (e) {
        console.warn(`[imessage] init failed: ${e.message}; bucket will no-op`);
        imessageDb = null;
      }
    }
    const imessageTick = async () => {
      if (!imessageDb) return;
      try {
        const { surql: sql } = await import('surrealdb');
        const [rows] = await ctx.db
          .query(sql`SELECT * FROM type::record('runtime', 'imessage_cursor')`)
          .collect();
        const cursor = Number.isInteger(rows?.[0]?.value?.last_rowid) ? rows[0].value.last_rowid : 0;
        const result = await imessagePollOnce({
          db: imessageDb,
          allowlist: imessageAllowlist,
          recordEvent: (e) => recordEvent(ctx.db, ctx.embedder.wrap, e),
          getCursor: async () => cursor,
          setCursor: async (v) =>
            ctx.db
              .query(sql`UPSERT type::record('runtime', 'imessage_cursor') SET value = ${{ last_rowid: v }}`)
              .collect(),
          logger: console,
        });
        if (result.allowed > 0 || result.skipped_self > 5) {
          console.log(
            `[imessage] tick: polled=${result.polled} allowed=${result.allowed} self=${result.skipped_self} denied=${result.skipped_allowlist}`,
          );
        }
      } catch (e) {
        console.warn(`[imessage] tick failed: ${e.message}`);
      }
    };

    // Cognition D1: per-source state_inference cadence. Read tick_ms once at
    // boot; defaults to 5 minutes. Subsequent flag flips are picked up by
    // evaluateStateInference's own 5-second config cache (no restart needed).
    const stateInferenceCfg = await readStateInferenceConfig(ctx.db).catch(() => ({
      tick_ms: 300_000,
    }));
    const stateInferenceTickMs = Number.isInteger(stateInferenceCfg?.tick_ms)
      ? stateInferenceCfg.tick_ms
      : 300_000;

    const scheduler = createScheduler({
      buckets: [
        {
          name: 'dispatcher',
          intervalMs: 60_000,
          gate: () => !!ctx.host,
          tick: dispatcherTick,
          fireImmediately: true,
        },
        {
          name: 'cadence',
          intervalMs: 60_000,
          gate: () => !!ctx.host,
          tick: () => consumePendingTriggers(ctx.db, ctx.host),
        },
        {
          name: 'stale-sessions',
          intervalMs: 60_000,
          tick: () => markStaleSessions(ctx.db),
        },
        {
          name: 'stale-episodes',
          intervalMs: 600_000,
          tick: () => closeStaleEpisodes(ctx.db),
        },
        {
          name: 'action-decay',
          intervalMs: 6 * 60 * 60_000,
          tick: () => runActionTrustDecay(ctx.db),
        },
        {
          // Cognition D1 — heartbeat-paced state-inference faculty. Gated on
          // host presence (needs invokeLLM) and on cfg.enabled internally;
          // false→no-op, 'shadow'→runs the pipeline without writing memos,
          // true→full path.
          //
          // Wrapped in `withRuntimeJobsTracking` so each tick updates
          // `runtime_jobs.last_run_at` / `next_run_at` / `last_run_ok` —
          // otherwise `robin jobs list` shows the job as stuck because
          // scheduler_driven jobs bypass `runOneJob`.
          name: 'state-inference',
          intervalMs: stateInferenceTickMs,
          gate: () => !!ctx.host,
          tick: withRuntimeJobsTracking(ctx.db, 'state-inference', stateInferenceTickMs, () =>
            evaluateStateInference({
              db: ctx.db,
              host: ctx.host,
              embedder: ctx.embedder.wrap,
            }),
          ),
        },
        {
          name: 'host-watchdog',
          intervalMs: 5 * 60_000,
          gate: () => !ctx.host,
          tick: async () => {
            try {
              const h = await detectHost();
              if (h) {
                ctx.setHost(h);
                console.log('[daemon] host detected by watchdog — dispatcher + cadence active');
              }
            } catch {
              /* still no host, keep trying */
            }
          },
        },
        {
          // Operational-invariants framework (defensive reliability layer).
          // Gated by config.invariants.enabled (false | 'shadow' | true).
          // No-op when flag is false. Read each tick — flips take effect inline.
          name: 'invariants',
          intervalMs: 60_000,
          tick: createInvariantsTick({ db: ctx.db }),
        },
        {
          // Cognition E1 — heartbeat-paced prediction resolution (spec §4a).
          // Reads memos WHERE kind='prediction' AND resolved_at IS NONE AND
          // expected_resolution_at + grace <= now(), dispatches per-kind resolvers,
          // and writes back correct/actual_outcome or sets surface_in_brief=true.
          // Gated on runtime:self-improvement-v2.value.enabled (default false);
          // tick is registered but no-ops when flag is false.
          name: 'resolve-due-predictions',
          intervalMs: 5 * 60_000,
          tick: () => resolveDuePredictions({ db: ctx.db }),
        },
        {
          // Cognition E1 — Phase 2 monitoring: task_outcome write-rate drift
          // watchdog (spec §6). Stamps phase2_started_at on first tick after
          // flag=true, locks in baseline after 72 h, then auto-disables the v2
          // flag if the trailing-1h write rate drifts > 50% from baseline.
          // Gated on runtime:self-improvement-v2.value.enabled; no-op when false.
          name: 'task-outcome-drift-watchdog',
          intervalMs: 5 * 60_000,
          tick: () => runTaskOutcomeDriftWatchdog({ db: ctx.db }),
        },
        {
          // Cognition E1 — Phase 2 monitoring: 6-hour cost sub-tick (spec §6).
          // Has an internal gate (cost_monitor_last_run_at) so the 5-min bucket
          // only does real work every 6 h. Sums introspection + dream LLM spend
          // from telemetry_hourly (or cadence_telemetry fallback), projects daily
          // cost, and writes a watch-list event if projected > 2× daily budget.
          // Gated on runtime:self-improvement-v2.value.enabled; no-op when false.
          name: 'cost-monitor',
          intervalMs: 5 * 60_000,
          tick: () => runCostMonitor({ db: ctx.db }),
        },
        {
          // M1 trigger engine — 5s polling tick. Reads new events since the
          // persisted cursor, dispatches matching triggers, advances cursor.
          // No-op when zero triggers are registered. Kill switch:
          // ROBIN_DISABLE_TRIGGERS=1.
          name: 'triggers',
          intervalMs: 5_000,
          gate: () => process.env.ROBIN_DISABLE_TRIGGERS !== '1',
          tick: triggerTick,
        },
        {
          // M2 iMessage inbox poller — gated on ROBIN_IMESSAGE_ENABLED=1 +
          // successful chat.db open (Full Disk Access). When disabled this
          // is cheap (gate returns false immediately).
          name: 'imessage-inbox',
          intervalMs: 10_000,
          gate: () => !!imessageDb,
          tick: imessageTick,
        },
      ],
    });
    await scheduler.start();

    // Introspection faculty — polls task_close_queue on a 1-min tick, runs
    // structural outcome inference + inline LLM grading (Wave 3) when budget
    // allows, and writes task_outcome memos.
    // Gated on runtime:self-improvement-v2.value.enabled (default false), so
    // start() is a no-op on a fresh install.  Fail-soft: a boot failure here
    // logs but does not abort the daemon.
    // ctx.host may be null here if no host has been detected yet — that's fine;
    // faculty will run structural-only until the host watchdog fires a restart.
    try {
      await startIntrospection({ db: ctx.db, host: ctx.host ?? null });
    } catch (e) {
      console.warn(`[introspection] faculty start failed (non-fatal): ${e.message}`);
    }

    // One-shot boot-time invariants run. Skipped when flag is false.
    // Failures here log but do not abort daemon boot — the heartbeat bucket
    // catches the same condition on the next tick.
    try {
      const bootReport = await runBootInvariants({ db: ctx.db });
      if (bootReport && !bootReport.skipped && bootReport.aborted) {
        console.warn('[invariants/boot] aborted; see invariants-state.json');
      }
    } catch (e) {
      console.warn(`[invariants/boot] failed: ${e.message}`);
    }

    // Token gates /sse, /messages, and /internal/* endpoints. CLI reads
    // from runtime/daemon/.state (mode 0600); MCP clients read from
    // .mcp.json's headers. Loopback binding stops remote attackers; the
    // token stops co-resident processes (browser tabs that bypass the
    // origin check, other apps running as the same user that can't read
    // .mcp.json) from invoking tools.
    const httpServer = startHttp({ ctx, tools, routes, port, authToken });

    // Hot-reload: SIGTERM self on user-data .js change so launchctl respawns
    // with a fresh ESM module graph. Without this, edits to
    // user-data/jobs/**/*.js (and user-data/io/**/*.js) silently use the
    // cached pre-edit module — the root cause of the 2026-05-16 daily-briefing
    // schema_version=2 regression. Disabled via env to keep tests + headless
    // CI runs from surprise-bouncing themselves.
    const hotReload =
      process.env.ROBIN_DISABLE_HOT_RELOAD === '1'
        ? { stop() {} }
        : startJobHotReload({
            paths: [paths.data.jobs(), `${paths.data.home()}/io`],
            log: console.log,
          });

    lifecycle.ready({
      scheduler,
      httpServer,
      hotReload,
      integrations: {
        stop: async () => {
          // Introspection faculty stop (sibling to biographer, dream, intuition).
          // Stopped here — after scheduler drain — so any in-flight drain tick
          // completes before we close timers and DB.
          try {
            await stopIntrospection();
          } catch (e) {
            console.warn(`[introspection] stop failed: ${e.message}`);
          }
          for (const [name, client] of ctx.gatewayClients) {
            const m = ctx.registry.get(name);
            if (m?.stop) {
              try {
                await m.stop({ log: console.log }, client);
                console.log(`integration ${name}: stopped`);
              } catch (e) {
                console.warn(`integration ${name}: stop failed: ${e.message}`);
              }
            }
          }
        },
      },
      db: { close: ctx.closeDb },
    });
    await lifecycle.writeReady({
      port,
      pid: process.pid,
      version: ctx.version,
      startedAt: ctx.startedAt.toISOString(),
      toolCount: tools.length,
      authToken,
    });

    console.log(`robin-mcp daemon ready on 127.0.0.1:${port}`);
    await lifecycle.wait();
  } catch (e) {
    await lifecycle.fail(e);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDaemon();
}
