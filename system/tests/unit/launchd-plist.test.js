import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateLaunchdPlist } from '../../runtime/install/launchd-plist.js';

test('generateLaunchdPlist produces a valid plist with ROBIN_HOME, KeepAlive=true, and correct log path', () => {
  const xml = generateLaunchdPlist({
    packageRoot: '/opt/robin',
    robinHome: '/Users/x/.robin-data',
  });
  assert.match(xml, /<key>Label<\/key>\s*<string>io\.robin-assistant\.mcp<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /\/opt\/robin\/system\/bin\/robin/);
  assert.match(xml, /<string>mcp<\/string>/);
  assert.match(xml, /<string>start<\/string>/);
  assert.match(xml, /<string>--foreground<\/string>/);
  assert.match(xml, /<key>ROBIN_HOME<\/key>\s*<string>\/Users\/x\/\.robin-data<\/string>/);
  assert.match(xml, /\/Users\/x\/\.robin-data\/cache\/logs\/daemon\.log/);
  // Must NOT contain old ~/.robin/logs literal
  assert.doesNotMatch(xml, /\.robin\/logs/);
});

test('generateLaunchdPlist escapes XML special chars in paths', () => {
  // Unusual but legal POSIX paths can contain `&`, `<`, `>`. Unescaped, these
  // produce a plist that launchd refuses to load.
  const xml = generateLaunchdPlist({
    packageRoot: '/opt/r&d',
    robinHome: '/Users/<weird>/data',
  });
  assert.match(xml, /\/opt\/r&amp;d\/system\/bin\/robin/);
  assert.match(xml, /<string>\/Users\/&lt;weird&gt;\/data<\/string>/);
  // Raw `&`, `<`, `>` in path positions would indicate missing escapes.
  assert.doesNotMatch(xml, /\/opt\/r&d\//);
  assert.doesNotMatch(xml, /\/Users\/<weird>\//);
});
