import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateLaunchdPlist } from '../../src/install/launchd-plist.js';

test('generateLaunchdPlist produces a valid plist with KeepAlive + RunAtLoad=false', () => {
  const xml = generateLaunchdPlist({
    label: 'io.robin-assistant.mcp',
    nodeBin: '/usr/local/bin/node',
    serverPath: '/Users/x/v2/src/daemon/server.js',
    home: '/Users/x',
  });
  assert.match(xml, /<key>Label<\/key>\s*<string>io\.robin-assistant\.mcp<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>/);
  assert.match(xml, /SuccessfulExit/);
  assert.match(xml, /\/usr\/local\/bin\/node/);
});
