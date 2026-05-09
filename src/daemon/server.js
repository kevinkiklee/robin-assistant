import { createServer } from 'node:http';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { biographerProcess } from '../capture/biographer.js';
import { close, connect } from '../db/client.js';
import { createTransformersEmbedder } from '../embed/embedder.js';
import { detectHost } from '../hosts/detect.js';
import { createRepeatQueryDetector } from '../mcp/implicit-signals.js';
import { createFindEntityTool } from '../mcp/tools/find-entity.js';
import { createGetEntityTool } from '../mcp/tools/get-entity.js';
import { createHealthTool } from '../mcp/tools/health.js';
import { createListEpisodesTool } from '../mcp/tools/list-episodes.js';
import { createMarkRecallUsedTool } from '../mcp/tools/mark-recall-used.js';
import { createRecallTool } from '../mcp/tools/recall.js';
import { createRecordCorrectionTool } from '../mcp/tools/record-correction.js';
import { createRelatedEntitiesTool } from '../mcp/tools/related-entities.js';
import { createRememberTool } from '../mcp/tools/remember.js';
import { createRunBiographerTool } from '../mcp/tools/run-biographer.js';
import { ensureHome, paths } from '../runtime/home.js';
import { createBiographerQueue } from './biographer-queue.js';
import { createIdleEmbedder } from './idle-embedder.js';
import { acquireDaemonLock, releaseDaemonLock } from './lock.js';
import { bindFreePort } from './port.js';
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
  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (httpServer) httpServer.close();
    if (dbHandle) await close(dbHandle).catch(() => {});
    await clearDaemonState(statePath).catch(() => {});
    await releaseDaemonLock(lockPath).catch(() => {});
  }

  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });

  try {
    dbHandle = await connect({ engine: `rocksdb://${p.db}` });

    const idleEmbedder = createIdleEmbedder({
      factory: () => createTransformersEmbedder(),
      idleMs: 600_000,
    });
    let host = null;
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
    ];

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
