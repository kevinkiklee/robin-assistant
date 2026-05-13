import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateLaunchdPlist } from '../../runtime/install/launchd-plist.js';

test('generateLaunchdPlist produces a valid plist with ROBIN_HOME, KeepAlive=true, and correct log path', () => {
  const xml = generateLaunchdPlist({
    packageRoot: '/opt/robin',
    robinHome: '/Users/x/.robin-data',
    nodePath: '/usr/local/bin/node',
  });
  assert.match(xml, /<key>Label<\/key>\s*<string>io\.robin-assistant\.mcp<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  // ProgramArguments must start with the absolute node binary so launchd's
  // stripped PATH doesn't break `#!/usr/bin/env node` resolution.
  assert.match(
    xml,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/opt\/robin\/system\/bin\/robin<\/string>/,
  );
  assert.match(xml, /<string>mcp<\/string>/);
  assert.match(xml, /<string>start<\/string>/);
  assert.match(xml, /<string>--foreground<\/string>/);
  assert.match(xml, /<key>ROBIN_HOME<\/key>\s*<string>\/Users\/x\/\.robin-data<\/string>/);
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:/);
  assert.match(xml, /\/Users\/x\/\.robin-data\/runtime\/logs\/daemon\.log/);
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
