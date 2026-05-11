import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { bindFreePort, getServerAddress } from '../../runtime/daemon/port.js';

test('bindFreePort binds 127.0.0.1:0 and returns server + port', async () => {
  const { server, port } = await bindFreePort();
  assert.ok(typeof port === 'number' && port > 0);
  server.close();
});

test('getServerAddress returns the actual bound port', async () => {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = getServerAddress(server);
  assert.equal(addr.address, '127.0.0.1');
  assert.ok(addr.port > 0);
  server.close();
});
