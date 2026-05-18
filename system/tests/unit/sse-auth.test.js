import { strict as assert } from 'node:assert';
import test from 'node:test';
import { startHttp } from '../../runtime/daemon/http.js';

// Bring up the daemon HTTP surface on an ephemeral port, then poke each
// route from a loopback client to verify the auth gate. No daemon boot,
// no DB — startHttp is pure.
function bring({ authToken = null, tools = [] } = {}) {
  return new Promise((resolve) => {
    const ctx = { version: 'test', sessions: { count: 0 } };
    const server = startHttp({ ctx, tools, routes: [], port: 0, authToken });
    server.on('listening', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('/healthz works without a token', async () => {
  const { server, base } = await bring({ authToken: 'secret-1234' });
  try {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('/sse is 401 without a token', async () => {
  const { server, base } = await bring({ authToken: 'secret-1234' });
  try {
    const res = await fetch(`${base}/sse`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.name, 'RobinUnauthorizedError');
  } finally {
    server.close();
  }
});

test('/sse is 401 with a wrong token', async () => {
  const { server, base } = await bring({ authToken: 'secret-1234' });
  try {
    const res = await fetch(`${base}/sse`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('/messages is 401 without a token', async () => {
  const { server, base } = await bring({ authToken: 'secret-1234' });
  try {
    const res = await fetch(`${base}/messages?sessionId=anything`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('/internal/* is 401 without a token', async () => {
  const { server, base } = await bring({ authToken: 'secret-1234' });
  try {
    const res = await fetch(`${base}/internal/anything`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('correct token passes the auth gate (404 from route table, not 401)', async () => {
  const { server, base } = await bring({ authToken: 'secret-1234' });
  try {
    // We don't have an actual SSE client; what we want to assert is that
    // the auth check passes. /internal/nonexistent + Bearer secret-1234
    // should fall through to the 404 path, not 401.
    const res = await fetch(`${base}/internal/nonexistent`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-1234', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

// Loopback-Host rejection isn't covered here: undici (Node's fetch impl)
// strips/overwrites the Host header, so a malicious-Host probe via fetch
// always carries Host: 127.0.0.1:<port>. The loopback check IS exercised
// by the daemon's integration tests against the real server.
