import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export interface MockRoute {
  method: 'POST' | 'GET';
  path: string;
  status?: number;
  body: unknown;
}

export async function startMockServer(routes: MockRoute[]): Promise<{ url: string; server: Server }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}
