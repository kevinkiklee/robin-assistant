import { runActionTrustDecay } from '../../cognition/jobs/action-trust.js';
import { closeStaleEpisodes } from '../../cognition/jobs/internal/close-stale-episodes.js';
import {
  evaluateStateInference,
  readStateInferenceConfig,
} from '../../cognition/jobs/internal/state-inference.js';
import { paths } from '../../config/data-store.js';
import { detectHost } from '../hosts/detect.js';
import { boot } from './boot.js';
import { consumePendingTriggers } from './cadence-consumer.js';
import { createDispatcherTick } from './dispatcher-tick.js';
import { createScheduler } from './heartbeat.js';
import { startHttp } from './http.js';
import { createLifecycle } from './lifecycle.js';
import { bindFreePort } from './port.js';
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
  const lifecycle = createLifecycle({
    lockPath: paths.data.daemonLock(),
    statePath: paths.data.daemonState(),
    logDir: `${paths.data.home()}/logs`,
  });
  await lifecycle.acquireLock();

  try {
    const ctx = await boot();
    const tools = buildTools(ctx);
    const routes = buildRoutes();
    const { server: probe, port } = await bindFreePort();
    probe.close();

    const dispatcherTick = createDispatcherTick(ctx, tools);

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
          name: 'state-inference',
          intervalMs: stateInferenceTickMs,
          gate: () => !!ctx.host,
          tick: () =>
            evaluateStateInference({
              db: ctx.db,
              host: ctx.host,
              embedder: ctx.embedder.wrap,
            }),
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
      ],
    });
    scheduler.start();

    const httpServer = startHttp({ ctx, tools, routes, port });

    lifecycle.ready({
      scheduler,
      httpServer,
      integrations: {
        stop: async () => {
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
