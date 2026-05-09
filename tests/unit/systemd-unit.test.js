import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateSystemdUnit } from '../../src/install/systemd-unit.js';

test('generateSystemdUnit produces a user unit with Restart=on-failure', () => {
  const txt = generateSystemdUnit({
    nodeBin: '/usr/bin/node',
    serverPath: '/home/x/v2/src/daemon/server.js',
  });
  assert.match(txt, /\[Unit\]/);
  assert.match(txt, /\[Service\]/);
  assert.match(txt, /\[Install\]/);
  assert.match(txt, /Restart=on-failure/);
  assert.match(txt, /\/usr\/bin\/node/);
});
