import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  installDaemonLaunchd,
  LAUNCHD_LABEL,
  plistPath,
  renderDaemonPlist,
  uninstallDaemonLaunchd,
} from './install.ts';

test('renderDaemonPlist: includes node + cli path + daemon --foreground args', () => {
  const xml = renderDaemonPlist({
    nodePath: '/opt/node/bin/node',
    cliPath: '/repo/dist/surfaces/cli/index.js',
    userDataDir: '/data/robin',
    path: '/usr/bin:/bin',
  });
  assert.match(xml, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/repo\/dist\/surfaces\/cli\/index\.js<\/string>/);
  assert.match(xml, /<string>daemon<\/string>/);
  assert.match(xml, /<string>--foreground<\/string>/);
});

test('renderDaemonPlist: writes ROBIN_USER_DATA_DIR + PATH into EnvironmentVariables', () => {
  const xml = renderDaemonPlist({
    nodePath: '/n',
    cliPath: '/c.js',
    userDataDir: '/data/robin',
    path: '/usr/bin',
  });
  assert.match(xml, /<key>ROBIN_USER_DATA_DIR<\/key>\s*<string>\/data\/robin<\/string>/);
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/usr\/bin<\/string>/);
});

test('renderDaemonPlist: log path lives under user-data/observability/logs', () => {
  const xml = renderDaemonPlist({
    nodePath: '/n',
    cliPath: '/c.js',
    userDataDir: '/data/robin',
  });
  assert.match(
    xml,
    /<key>StandardOutPath<\/key>\s*<string>\/data\/robin\/observability\/logs\/daemon\.log<\/string>/,
  );
});

test('renderDaemonPlist: XML-escapes ampersands in paths', () => {
  const xml = renderDaemonPlist({
    nodePath: '/n',
    cliPath: '/c.js',
    userDataDir: '/data/a&b',
  });
  assert.match(xml, /<string>\/data\/a&amp;b<\/string>/);
  assert.doesNotMatch(xml, /a&b</);
});

test('renderDaemonPlist: KeepAlive + RunAtLoad are set', () => {
  const xml = renderDaemonPlist({ nodePath: '/n', cliPath: '/c.js', userDataDir: '/d' });
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test('plistPath: places plist under ~/Library/LaunchAgents with canonical label', () => {
  const path = plistPath({ home: '/Users/test' });
  assert.equal(path, `/Users/test/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
});

test('installDaemonLaunchd (skipLoad=true): writes plist without invoking launchctl', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-launchd-'));
  const userDataDir = mkdtempSync(join(tmpdir(), 'robin-ud-'));
  const r = installDaemonLaunchd(
    {
      nodePath: '/opt/node/bin/node',
      cliPath: '/repo/dist/surfaces/cli/index.js',
      userDataDir,
    },
    { home, skipLoad: true },
  );
  assert.equal(r.loaded, false);
  assert.equal(r.alreadyLoaded, false);
  const xml = readFileSync(r.plistPath, 'utf8');
  assert.match(xml, /<string>\/repo\/dist\/surfaces\/cli\/index\.js<\/string>/);
});

test('uninstallDaemonLaunchd: returns removed=false when plist absent', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-launchd-'));
  const r = uninstallDaemonLaunchd({ home });
  assert.equal(r.removed, false);
  assert.equal(r.unloaded, false);
});

test('uninstallDaemonLaunchd: removes plist file when present', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-launchd-'));
  const agentDir = join(home, 'Library', 'LaunchAgents');
  mkdirSync(agentDir, { recursive: true });
  const path = plistPath({ home });
  writeFileSync(path, '<plist/>');
  const r = uninstallDaemonLaunchd({ home });
  // We can't reliably test launchctl unload (the plist was never actually
  // loaded into launchd), so we only assert the file removal half.
  assert.equal(r.removed, true);
});
