import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
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
        if (req.method === 'POST' && req.url?.startsWith('/hooks/')) {
          const kind = req.url.slice('/hooks/'.length);
          const body = await readBody(req);
          let payload: unknown = {};
          if (body) {
            try { payload = JSON.parse(body); } catch { payload = { raw: body }; }
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
    })();
  });

  const requestedPort = deps.port ?? 41273;
  const host = 'localhost';

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
