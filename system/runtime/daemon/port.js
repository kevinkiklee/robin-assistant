import { createServer } from 'node:http';

/**
 * Bind a loopback TCP port. If `preferred` is non-zero, try it first; on
 * EADDRINUSE, transparently fall back to an ephemeral port so the daemon
 * still comes up. Callers that need to know whether the preferred port was
 * actually obtained can compare `port` to what they passed in.
 */
export async function bindPort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err) => {
      if (preferred !== 0 && err.code === 'EADDRINUSE') {
        const fallback = createServer();
        fallback.once('error', reject);
        fallback.listen(0, '127.0.0.1', () => {
          resolve({ server: fallback, port: fallback.address().port });
        });
        return;
      }
      reject(err);
    });
    server.listen(preferred, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// Back-compat alias for the original API.
export const bindFreePort = () => bindPort(0);

export function getServerAddress(server) {
  return server.address();
}
