import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateSystemdUnit } from '../../runtime/install/systemd-unit.js';

test('generateSystemdUnit produces a user unit with ROBIN_HOME, Restart=on-failure, and correct log path', () => {
  const txt = generateSystemdUnit({
    packageRoot: '/opt/robin',
    robinHome: '/home/x/.robin-data',
    nodePath: '/usr/local/bin/node',
  });
  assert.match(txt, /\[Unit\]/);
  assert.match(txt, /\[Service\]/);
  assert.match(txt, /\[Install\]/);
  assert.match(txt, /Restart=on-failure/);
  assert.match(txt, /Environment=ROBIN_HOME=\/home\/x\/\.robin-data/);
  assert.match(
    txt,
    /ExecStart=\/usr\/local\/bin\/node \/opt\/robin\/system\/bin\/robin mcp start --foreground/,
  );
  assert.match(txt, /Environment=PATH=\/usr\/local\/bin:/);
  assert.match(txt, /\/home\/x\/\.robin-data\/cache\/logs\/daemon\.log/);
});
