import { createServer } from 'node:http';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { surql } from 'surrealdb';
import { biographerProcess } from '../capture/biographer.js';
import { close, connect } from '../db/client.js';
import { dreamProcess } from '../dream/pipeline.js';
import { createTransformersEmbedder } from '../embed/embedder.js';
import { detectHost } from '../hosts/detect.js';
import { readSecrets } from '../integrations/_auth/secrets-io.js';
import { resetInFlightFlags } from '../integrations/_framework/boot-cleanup.js';
import { createCapture } from '../integrations/_framework/capture.js';
import { loadManifests } from '../integrations/_framework/manifest-loader.js';
import { runIntegrationSync } from '../integrations/_framework/run-sync.js';
import { createRepeatQueryDetector } from '../mcp/implicit-signals.js';
import { createFindEntityTool } from '../mcp/tools/find-entity.js';
import { createGetEntityTool } from '../mcp/tools/get-entity.js';
import { createGetHotTool } from '../mcp/tools/get-hot.js';
import { createGetKnowledgeTool } from '../mcp/tools/get-knowledge.js';
import { createGetProfileTool } from '../mcp/tools/get-profile.js';
import { createHealthTool } from '../mcp/tools/health.js';
import { createIntegrationRunTool } from '../mcp/tools/integration-run.js';
import { createIntegrationStatusTool } from '../mcp/tools/integration-status.js';
import { createListEpisodesTool } from '../mcp/tools/list-episodes.js';
import { createListJournalTool } from '../mcp/tools/list-journal.js';
import { createListPatternsTool } from '../mcp/tools/list-patterns.js';
import { createListRulesTool } from '../mcp/tools/list-rules.js';
import { createListThreadsTool } from '../mcp/tools/list-threads.js';
import { createMarkRecallUsedTool } from '../mcp/tools/mark-recall-used.js';
import { createRecallTool } from '../mcp/tools/recall.js';
import { createRecordCorrectionTool } from '../mcp/tools/record-correction.js';
import { createRelatedEntitiesTool } from '../mcp/tools/related-entities.js';
import { createRememberTool } from '../mcp/tools/remember.js';
import { createRunBiographerTool } from '../mcp/tools/run-biographer.js';
import { createRunDreamTool } from '../mcp/tools/run-dream.js';
import { createUpdateRuleTool } from '../mcp/tools/update-rule.js';
import { ensureHome, paths } from '../runtime/home.js';
import { createBiographerQueue } from './biographer-queue.js';
import { createIdleEmbedder } from './idle-embedder.js';
import { acquireDaemonLock, releaseDaemonLock } from './lock.js';
import { bindFreePort } from './port.js';
import { createScheduler } from './scheduler.js';
import { clearDaemonState, writeDaemonState } from './state.js';
import { getCliVersion } from './version-handshake.js';

export async function startDaemon() {
  const version = await getCliVersion();
  await ensureHome();
  const p = paths();
  const lockPath = join(p.home, '.daemon.lock');
  const statePath = join(p.home, '.daemon.state');

  await acquireDaemonLock(lockPath);

  const startedAt = new Date();
  let dbHandle = null;
  let httpServer = null;
  let scheduler = null;
  let shuttingDown = false;
  const gatewayClients = new Map();
  const registry = new Map();

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal) console.log(`daemon: received ${signal}, shutting down`);
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
    dbHandle = await connect({ engine: `rocksdb://${p.db}` });

    const idleEmbedder = createIdleEmbedder({
      factory: () => createTransformersEmbedder(),
      idleMs: 600_000,
    });
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
        const promise = queue.enqueue(id);
        promise
          .then(() => {
            lastBiographerRunAt = new Date().toISOString();
          })
          .catch(() => {});
        return promise;
      },
      get lastRunAt() {
        return lastBiographerRunAt;
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
    const manifests = await loadManifests(integrationsDir);

    for (const m of manifests) {
      const secrets = await readSecrets(m.name);
      const capture = createCapture({
        db: dbHandle,
        embedder: embedderWrap,
        source: m.name,
        embed: m.embed,
        mode: m.capture_mode,
      });
      registry.set(m.name, { ...m, secrets, capture });

      // Seed scheduler cursor for scheduled integrations (cadence_ms !== null).
      // (Note: dream cursor is seeded once below after the loop.)
      if (m.cadence_ms !== null) {
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
      }

      // Boot gateway integrations (cadence_ms === null with start fn).
      if (m.cadence_ms === null && m.start) {
        if (!secrets) {
          console.warn(
            `integration ${m.name}: gateway not started (no secrets at ~/.robin/secrets/${m.name}.json)`,
          );
          continue;
        }
        try {
          const ctx = {
            db: dbHandle,
            host,
            secrets,
            log: (...a) => console.log(`[${m.name}]`, ...a),
            capture,
          };
          const client = await m.start(ctx);
          gatewayClients.set(m.name, client);
          console.log(`integration ${m.name}: gateway started`);
        } catch (e) {
          console.warn(`integration ${m.name}: gateway start failed: ${e.message}`);
        }
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
      createMarkRecallUsedTool({ db: dbHandle }),
      createRecordCorrectionTool({
        db: dbHandle,
        embedder: embedderWrap,
        processor: queueWrap.enqueue,
      }),
      // Phase 2c read/update tools
      createGetKnowledgeTool({ db: dbHandle, embedder: embedderWrap }),
      createListPatternsTool({ db: dbHandle }),
      createGetProfileTool({ db: dbHandle }),
      createListThreadsTool({ db: dbHandle }),
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
    for (const m of manifests) {
      for (const factory of m.tools ?? []) {
        try {
          const tool = factory({ db: dbHandle });
          tools.push(tool);
        } catch (e) {
          console.warn(`integration ${m.name}: tool factory failed: ${e.message}`);
        }
      }
    }

    // Heartbeat scheduler: surveys due integrations + dream cursor each tick,
    // dispatches via runOne. Falls back to dream when nothing is due and the
    // un-biographed event queue overflows. Skipped without a host since dream
    // and biographer both need one.
    if (host) {
      scheduler = createScheduler({
        listDue: async () => {
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
          return due;
        },
        runOne: async (name) => {
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

    const { server: probe, port } = await bindFreePort();
    probe.close();

    httpServer = createServer(async (req, res) => {
      try {
        if (req.method === 'POST' && req.url === '/internal/biographer/process-pending') {
          const [pendingRows] = await dbHandle
            .query('SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50')
            .collect();
          for (const row of pendingRows) {
            queueWrap.enqueue(String(row.id)).catch(() => {});
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ enqueued: pendingRows.length }));
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
