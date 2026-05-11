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
