import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { startHttp } from '../../runtime/daemon/http.js';

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postRaw(port, path, raw) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

const stubCtx = { sessions: { count: 0 } };

test('success response includes ok: true and spreads data', async () => {
  const routes = [
    {
      method: 'POST',
      path: '/x',
      async handler() {
        return { value: 42 };
      },
    },
  ];
  const server = startHttp({ ctx: stubCtx, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, value: 42 });
  server.close();
});

test('envelope ok: true overrides handler-returned ok: false', async () => {
  const routes = [
    {
      method: 'POST',
      path: '/x',
      async handler() {
        return { ok: false, value: 1 };
      },
    },
  ];
  const server = startHttp({ ctx: stubCtx, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', {});
  assert.equal(r.body.ok, true);
  assert.equal(r.body.value, 1);
  server.close();
});

test('thrown error returns 500 with ok: false envelope', async () => {
  const routes = [
    {
      method: 'POST',
      path: '/x',
      async handler() {
        const e = new Error('boom');
        e.name = 'TestError';
        throw e;
      },
    },
  ];
  const server = startHttp({ ctx: stubCtx, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', {});
  assert.equal(r.status, 500);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'boom');
  assert.equal(r.body.name, 'TestError');
  server.close();
});

test('schema validation rejects bad body with 400 RobinValidationError', async () => {
  const routes = [
    {
      method: 'POST',
      path: '/x',
      schema: { name: 'string' },
      async handler() {
        return { wrapped: true };
      },
    },
  ];
  const server = startHttp({ ctx: stubCtx, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', { wrong: 'field' });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.name, 'RobinValidationError');
  assert.ok(Array.isArray(r.body.validation));
  server.close();
});

test('invalid JSON returns 400 with RobinInvalidJsonError', async () => {
  const routes = [
    {
      method: 'POST',
      path: '/x',
      schema: { name: 'string' },
      async handler() {
        return {};
      },
    },
  ];
  const server = startHttp({ ctx: stubCtx, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postRaw(port, '/x', '{ not valid json');
  assert.equal(r.status, 400);
  assert.equal(r.body.name, 'RobinInvalidJsonError');
  server.close();
});

test('_status escape hatch bypasses envelope', async () => {
  const routes = [
    {
      method: 'POST',
      path: '/x',
      async handler() {
        return { _status: 207, _body: { enqueued: 5, dropped: 1 } };
      },
    },
  ];
  const server = startHttp({ ctx: stubCtx, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', {});
  assert.equal(r.status, 207);
  assert.equal(r.body.enqueued, 5);
  assert.equal(r.body.dropped, 1);
  assert.equal(r.body.ok, undefined);
  server.close();
});

test('schema accepts valid body, hands typed value to handler', async () => {
  let received = null;
  const routes = [
    {
      method: 'POST',
      path: '/x',
      schema: { name: 'string', force: 'boolean?' },
      async handler({ body }) {
        received = body;
        return { name: body.name };
      },
    },
  ];
  const server = startHttp({ ctx: stubCtx, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', { name: 'alice' });
  assert.equal(r.status, 200);
  assert.deepEqual(received, { name: 'alice' });
  assert.deepEqual(r.body, { ok: true, name: 'alice' });
  server.close();
});

test('unmatched route returns 404', async () => {
  const server = startHttp({ ctx: stubCtx, tools: [], routes: [], port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/nope', {});
  assert.equal(r.status, 404);
  server.close();
});

test('readJsonBody rejects payloads over MAX_BODY_BYTES with RobinPayloadTooLargeError', async () => {
  // Unit-test readJsonBody directly with a mock readable. The integration
  // path (HTTP client → server → 413) involves duplex behaviour that's
  // awkward to drive synchronously from a test; the contract under test is
  // the rejection semantics, not the wire-level cleanup, which the http
  // dispatcher owns.
  const { readJsonBody, MAX_BODY_BYTES } = await import('../../runtime/daemon/http.js');
  const { EventEmitter } = await import('node:events');
  const mockReq = new EventEmitter();
  const promise = readJsonBody(mockReq);
  // Emit one chunk that exceeds the cap in a single tick.
  mockReq.emit('data', Buffer.alloc(MAX_BODY_BYTES + 1, 'a'));
  await assert.rejects(promise, (e) => e.name === 'RobinPayloadTooLargeError');
});

test('readJsonBody accumulates chunks up to MAX_BODY_BYTES then rejects', async () => {
  const { readJsonBody, MAX_BODY_BYTES } = await import('../../runtime/daemon/http.js');
  const { EventEmitter } = await import('node:events');
  const mockReq = new EventEmitter();
  const promise = readJsonBody(mockReq);
  // Two chunks: 4 MB + 1.5 MB → 5.5 MB total → over 5 MB cap on the second chunk.
  mockReq.emit('data', Buffer.alloc(4 * 1024 * 1024, 'a'));
  mockReq.emit('data', Buffer.alloc(Math.ceil(1.5 * 1024 * 1024), 'a'));
  await assert.rejects(promise, (e) => e.name === 'RobinPayloadTooLargeError');
  // MAX_BODY_BYTES is exported (export contract surface).
  assert.equal(typeof MAX_BODY_BYTES, 'number');
  assert.ok(MAX_BODY_BYTES > 0);
});

// ---------- Bearer-token gate on /internal/* ----------

function postWithHeaders(port, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const internalRoutes = [
  {
    method: 'POST',
    path: '/internal/echo',
    async handler({ body }) {
      return { received: body };
    },
  },
  {
    method: 'POST',
    path: '/public',
    async handler() {
      return { ok2: true };
    },
  },
];

test('/internal/* requires Authorization when authToken set', async () => {
  const server = startHttp({
    ctx: stubCtx,
    tools: [],
    routes: internalRoutes,
    port: 0,
    authToken: 'secret-token-abc',
  });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/internal/echo', { hello: 1 });
  assert.equal(r.status, 401);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.name, 'RobinUnauthorizedError');
  server.close();
});

test('/internal/* with wrong Authorization → 401', async () => {
  const server = startHttp({
    ctx: stubCtx,
    tools: [],
    routes: internalRoutes,
    port: 0,
    authToken: 'secret-token-abc',
  });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postWithHeaders(
    port,
    '/internal/echo',
    { hello: 1 },
    { authorization: 'Bearer wrong-token' },
  );
  assert.equal(r.status, 401);
  server.close();
});

test('/internal/* with correct Authorization → 200', async () => {
  const server = startHttp({
    ctx: stubCtx,
    tools: [],
    routes: internalRoutes,
    port: 0,
    authToken: 'secret-token-abc',
  });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postWithHeaders(
    port,
    '/internal/echo',
    { hello: 1 },
    { authorization: 'Bearer secret-token-abc' },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, received: { hello: 1 } });
  server.close();
});

test('non-/internal routes do NOT require Authorization', async () => {
  const server = startHttp({
    ctx: stubCtx,
    tools: [],
    routes: internalRoutes,
    port: 0,
    authToken: 'secret-token-abc',
  });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/public', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, ok2: true });
  server.close();
});

test('omitting authToken skips the gate entirely (backward compat)', async () => {
  const server = startHttp({ ctx: stubCtx, tools: [], routes: internalRoutes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/internal/echo', { hi: 2 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, received: { hi: 2 } });
  server.close();
});
