import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface MockRoute {
  method: 'POST' | 'GET';
  path: string;
  status?: number;
  body: unknown;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  body: unknown;
}

export async function startMockServer(
  routes: MockRoute[],
): Promise<{ url: string; server: Server; received: ReceivedRequest[] }> {
  const received: ReceivedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let parsed: unknown = raw;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        // leave parsed as the raw string
      }
      received.push({ method: req.method ?? '', path: req.url ?? '', body: parsed });
      const route = routes.find((r) => r.method === req.method && r.path === req.url);
      if (!route) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = route.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(route.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, server, received };
}
