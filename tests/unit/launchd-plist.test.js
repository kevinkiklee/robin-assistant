import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateLaunchdPlist } from '../../src/install/launchd-plist.js';

test('generateLaunchdPlist produces a valid plist with ROBIN_HOME, KeepAlive=true, and correct log path', () => {
  const xml = generateLaunchdPlist({
    packageRoot: '/opt/robin',
    robinHome: '/Users/x/.robin-data',
  });
  assert.match(xml, /<key>Label<\/key>\s*<string>io\.robin-assistant\.mcp<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /\/opt\/robin\/bin\/robin/);
  assert.match(xml, /<string>mcp<\/string>/);
  assert.match(xml, /<string>start<\/string>/);
  assert.match(xml, /<string>--foreground<\/string>/);
  assert.match(xml, /<key>ROBIN_HOME<\/key>\s*<string>\/Users\/x\/\.robin-data<\/string>/);
  assert.match(xml, /\/Users\/x\/\.robin-data\/cache\/logs\/daemon\.log/);
  // Must NOT contain old ~/.robin/logs literal
  assert.doesNotMatch(xml, /\.robin\/logs/);
});
