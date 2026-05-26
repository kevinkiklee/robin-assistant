import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildPrimer } from '../../brain/cognition/primer.ts';
import type { RobinDb } from '../../brain/memory/db.ts';

export interface HttpServerDeps {
  db: RobinDb;
  port?: number;
  onHook?: (kind: string, payload: unknown) => Promise<void> | void;
  isHealthy: () => boolean;
}

export interface HttpHandle {
  server: Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

export async function startHttpServer(deps: HttpServerDeps): Promise<HttpHandle> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    (async () => {
      try {
        if (req.method === 'GET' && req.url === '/health') {
          res.statusCode = deps.isHealthy() ? 200 : 503;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: deps.isHealthy(), ts: new Date().toISOString() }));
          return;
        }
        // SessionStart: build the LLM-free primer and return it as Claude Code's
        // `additionalContext` so the hook's stdout becomes injected session context.
        // buildPrimer is cheap (SQL + small file reads) and must never throw on the
        // hot path — an empty primer degrades gracefully to no injected context.
        if (req.method === 'POST' && req.url === '/hooks/session_start') {
          // Drain the request body (Claude Code posts session metadata) even though the
          // primer doesn't need it — leaving it unread can wedge the socket.
          await readBody(req);
          let additionalContext = '';
          try {
            additionalContext = buildPrimer(deps.db);
          } catch {
            additionalContext = '';
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext,
              },
            }),
          );
          return;
        }
        if (req.method === 'POST' && req.url?.startsWith('/hooks/')) {
          const kind = req.url.slice('/hooks/'.length);
          const body = await readBody(req);
          let payload: unknown = {};
          if (body) {
            try {
              payload = JSON.parse(body);
            } catch {
              payload = { raw: body };
            }
          }
          if (deps.onHook) await deps.onHook(kind, payload);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ accepted: true, kind }));
          return;
        }
        res.statusCode = 404;
        res.end('not found');
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
    })().catch(() => {
      // Guard: if the try/catch block itself throws (shouldn't happen, but
      // defensive), prevent an unhandled promise rejection from crashing the
      // daemon. The inner catch already handles all known error paths.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal error');
      }
    });
  });

  const requestedPort = deps.port ?? 41273;
  // Bind explicitly to IPv4 loopback. `localhost` resolves dual-stack but Node's HTTP
  // server binds to whatever the OS returns first — on macOS that's `::1` (IPv6-only),
  // which silently breaks any client that connects via 127.0.0.1 with no IPv6 fallback
  // (curl, simple POSTs from shell hooks, etc.). The daemon only ever receives
  // localhost traffic, so 127.0.0.1 is sufficient and predictable.
  const host = '127.0.0.1';

  return await new Promise<HttpHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      const address = server.address();
      if (typeof address === 'string' || !address) {
        reject(new Error('Server address is not available'));
        return;
      }
      const actualPort = address.port;
      resolve({
        server,
        port: actualPort,
        host,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      });
    });
  });
}
