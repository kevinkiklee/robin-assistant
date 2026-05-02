// watches-cli.test.js — unit tests for the robin watch CLI surface.
// Tests invoke the command functions directly (no subprocess) using a
// temporary workspace and capturing stdout/stderr.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cmdWatchAdd,
  cmdWatchList,
  cmdWatchDisable,
  cmdWatchEnable,
  cmdWatchTail,
  cmdWatchRun,
} from '../../scripts/cli/watches.js';
import { parseWatchFile, readWatchState, serializeWatchFile } from '../../scripts/watches/lib/watches.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-watches-cli-'));
  mkdirSync(join(dir, 'user-data/memory/watches'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/streams'), { recursive: true });
  mkdirSync(join(dir, 'user-data/ops/state/watches'), { recursive: true });
  return dir;
}

/**
 * Capture stdout + stderr while running fn() in the given workspace.
 * Sets ROBIN_WORKSPACE env var to ws, then restores it.
 */
async function capture(ws, fn) {
  const origWs = process.env.ROBIN_WORKSPACE;
  process.env.ROBIN_WORKSPACE = ws;

  const outChunks = [];
  const errChunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { outChunks.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { errChunks.push(String(chunk)); return true; };

  let exitCode = null;
  const origExit = process.exit.bind(process);
  process.exit = (code) => { exitCode = code ?? 0; throw new Error(`process.exit(${code})`); };

  try {
    await fn();
  } catch (e) {
    if (!e.message.startsWith('process.exit(')) throw e;
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
    if (origWs === undefined) delete process.env.ROBIN_WORKSPACE;
    else process.env.ROBIN_WORKSPACE = origWs;
  }

  return {
    stdout: outChunks.join(''),
    stderr: errChunks.join(''),
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// robin watch add
// ---------------------------------------------------------------------------

test('watch add: creates watch file and state JSON', async () => {
  const ws = workspace();
  const { stdout } = await capture(ws, () => cmdWatchAdd(['sigma lens releases', '--cadence', 'daily', '--query', 'sigma lens 2026']));

  const watchFile = join(ws, 'user-data/memory/watches/sigma-lens-releases.md');
  assert.ok(existsSync(watchFile), 'watch file should be created');
  const { frontmatter } = parseWatchFile(readFileSync(watchFile, 'utf8'));
  assert.equal(frontmatter.id, 'sigma-lens-releases');
  assert.equal(frontmatter.topic, 'sigma lens releases');
  assert.equal(frontmatter.cadence, 'daily');
  assert.equal(frontmatter.query, 'sigma lens 2026');
  assert.equal(frontmatter.enabled, true);
  assert.equal(frontmatter.notify, false);

  const stateFile = join(ws, 'user-data/ops/state/watches/sigma-lens-releases.json');
  assert.ok(existsSync(stateFile), 'state file should be created');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.deepEqual(state.fingerprints, []);
  assert.equal(state.last_run_at, null);

  assert.match(stdout, /Created watch/);
  assert.match(stdout, /sigma-lens-releases/);
});

test('watch add: --notify flag sets notify: true', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['my topic', '--notify']));
  const watchFile = join(ws, 'user-data/memory/watches/my-topic.md');
  const { frontmatter } = parseWatchFile(readFileSync(watchFile, 'utf8'));
  assert.equal(frontmatter.notify, true);
});

test('watch add: default cadence is daily when not provided', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['another topic']));
  const watchFile = join(ws, 'user-data/memory/watches/another-topic.md');
  const { frontmatter } = parseWatchFile(readFileSync(watchFile, 'utf8'));
  assert.equal(frontmatter.cadence, 'daily');
});

test('watch add: collision handling appends -2, -3', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['collision topic']));
  await capture(ws, () => cmdWatchAdd(['collision topic']));
  await capture(ws, () => cmdWatchAdd(['collision topic']));

  assert.ok(existsSync(join(ws, 'user-data/memory/watches/collision-topic.md')));
  assert.ok(existsSync(join(ws, 'user-data/memory/watches/collision-topic-2.md')));
  assert.ok(existsSync(join(ws, 'user-data/memory/watches/collision-topic-3.md')));
});

test('watch add: auto-slug applied to topic', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['Aronofsky Blu-ray 4K release 2026']));
  const watchFile = join(ws, 'user-data/memory/watches/aronofsky-blu-ray-4k-release-2026.md');
  assert.ok(existsSync(watchFile), 'slugified watch file should exist');
});

test('watch add: invalid cadence exits with error', async () => {
  const ws = workspace();
  const { stderr, exitCode } = await capture(ws, () => cmdWatchAdd(['topic', '--cadence', 'monthly']));
  assert.match(stderr, /invalid cadence/);
  assert.equal(exitCode, 2);
});

test('watch add: missing topic exits with usage error', async () => {
  const ws = workspace();
  const { stderr, exitCode } = await capture(ws, () => cmdWatchAdd([]));
  assert.match(stderr, /usage/);
  assert.equal(exitCode, 2);
});

// ---------------------------------------------------------------------------
// robin watch list
// ---------------------------------------------------------------------------

test('watch list: empty workspace shows no-watches message', async () => {
  const ws = workspace();
  const { stdout } = await capture(ws, () => cmdWatchList([]));
  assert.match(stdout, /No watches found/);
});

test('watch list: shows watch entries', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['sigma lens', '--cadence', 'weekly']));
  await capture(ws, () => cmdWatchAdd(['another topic']));
  const { stdout } = await capture(ws, () => cmdWatchList([]));
  assert.match(stdout, /sigma-lens/);
  assert.match(stdout, /another-topic/);
  assert.match(stdout, /weekly/);
  assert.match(stdout, /daily/);
});

test('watch list: shows disabled status correctly', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['test watch']));
  await capture(ws, () => cmdWatchDisable(['test-watch']));
  const { stdout } = await capture(ws, () => cmdWatchList([]));
  // "no" should appear for the disabled watch (without ANSI)
  assert.match(stdout.replace(/\x1b\[[0-9;]*m/g, ''), /no/);
});

// ---------------------------------------------------------------------------
// robin watch disable / enable
// ---------------------------------------------------------------------------

test('watch disable: sets enabled: false', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['test topic']));
  await capture(ws, () => cmdWatchDisable(['test-topic']));
  const watchFile = join(ws, 'user-data/memory/watches/test-topic.md');
  const { frontmatter } = parseWatchFile(readFileSync(watchFile, 'utf8'));
  assert.equal(frontmatter.enabled, false);
});

test('watch enable: sets enabled: true after disable', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['test topic']));
  await capture(ws, () => cmdWatchDisable(['test-topic']));
  await capture(ws, () => cmdWatchEnable(['test-topic']));
  const watchFile = join(ws, 'user-data/memory/watches/test-topic.md');
  const { frontmatter } = parseWatchFile(readFileSync(watchFile, 'utf8'));
  assert.equal(frontmatter.enabled, true);
});

test('watch disable: exits with error for unknown id', async () => {
  const ws = workspace();
  const { stderr, exitCode } = await capture(ws, () => cmdWatchDisable(['nonexistent-id']));
  assert.match(stderr, /watch not found/);
  assert.equal(exitCode, 1);
});

test('watch enable: exits with error for unknown id', async () => {
  const ws = workspace();
  const { stderr, exitCode } = await capture(ws, () => cmdWatchEnable(['nonexistent-id']));
  assert.match(stderr, /watch not found/);
  assert.equal(exitCode, 1);
});

test('watch disable: missing id exits with usage', async () => {
  const ws = workspace();
  const { stderr, exitCode } = await capture(ws, () => cmdWatchDisable([]));
  assert.match(stderr, /usage/);
  assert.equal(exitCode, 2);
});

// ---------------------------------------------------------------------------
// robin watch tail
// ---------------------------------------------------------------------------

test('watch tail: empty inbox shows no-items message', async () => {
  const ws = workspace();
  const { stdout } = await capture(ws, () => cmdWatchTail([]));
  assert.match(stdout, /inbox\.md not found|No \[watch\]/);
});

test('watch tail: shows matching [watch] lines from inbox', async () => {
  const ws = workspace();
  const inboxPath = join(ws, 'user-data/memory/streams/inbox.md');
  writeFileSync(inboxPath, [
    '- [fact] some fact <!-- id:20260430-1000-aa01 -->',
    '- [watch:sigma-lens] Sigma 35mm f/1.4 DG DN release — new announcement (https://sigma-global.com): New full-frame lens announced for Sony E mount <!-- id:20260430-1001-bb01 -->',
    '- [watch:aronofsky] mother! 4K Blu-ray confirmed (https://example.com): Release date set for Q4 2026 <!-- id:20260430-1002-cc01 -->',
    '- [preference] some pref <!-- id:20260430-1003-dd01 -->',
  ].join('\n') + '\n');

  const { stdout } = await capture(ws, () => cmdWatchTail([]));
  assert.match(stdout, /sigma-lens/);
  assert.match(stdout, /aronofsky/);
  assert.ok(!stdout.includes('[fact]'), '[fact] items should not appear');
  assert.ok(!stdout.includes('[preference]'), '[preference] items should not appear');
});

test('watch tail: filters by id when provided', async () => {
  const ws = workspace();
  const inboxPath = join(ws, 'user-data/memory/streams/inbox.md');
  writeFileSync(inboxPath, [
    '- [watch:sigma-lens] Hit 1',
    '- [watch:aronofsky] Hit 2',
    '- [watch:sigma-lens] Hit 3',
  ].join('\n') + '\n');

  const { stdout } = await capture(ws, () => cmdWatchTail(['sigma-lens']));
  assert.match(stdout, /sigma-lens/);
  assert.ok(!stdout.includes('[watch:aronofsky]'), 'should not include other watch items');
});

test('watch tail: --n limits output count', async () => {
  const ws = workspace();
  const inboxPath = join(ws, 'user-data/memory/streams/inbox.md');
  const lines = Array.from({ length: 20 }, (_, i) => `- [watch:test] item ${i + 1}`);
  writeFileSync(inboxPath, lines.join('\n') + '\n');

  const { stdout } = await capture(ws, () => cmdWatchTail(['--n=3']));
  const resultLines = stdout.trim().split('\n').filter(Boolean);
  assert.equal(resultLines.length, 3);
});

// ---------------------------------------------------------------------------
// robin watch run
// ---------------------------------------------------------------------------

test('watch run --dry-run: prints what would happen', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['dry run topic', '--query', 'dry run query']));
  const { stdout } = await capture(ws, () => cmdWatchRun(['dry-run-topic', '--dry-run']));
  assert.match(stdout, /dry-run/);
  assert.match(stdout, /dry-run-topic/);
  assert.match(stdout, /dry run query/);
  assert.match(stdout, /fingerprints/);
});

test('watch run --bootstrap: initializes state without inbox write', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['bootstrap topic']));
  const { stdout } = await capture(ws, () => cmdWatchRun(['bootstrap-topic', '--bootstrap']));
  assert.match(stdout, /bootstrap/);
  // State should still have empty fingerprints (no fetch happened)
  const state = readWatchState(ws, 'bootstrap-topic');
  assert.deepEqual(state.fingerprints, []);
  assert.equal(state.consecutive_failures, 0);
});

test('watch run without flags: prints agent-runtime guidance', async () => {
  const ws = workspace();
  await capture(ws, () => cmdWatchAdd(['agent topic']));
  const { stdout } = await capture(ws, () => cmdWatchRun(['agent-topic']));
  assert.match(stdout, /agent-runtime|watch-topics/);
});

test('watch run: exits with error for unknown watch id', async () => {
  const ws = workspace();
  const { stderr, exitCode } = await capture(ws, () => cmdWatchRun(['nonexistent-id', '--dry-run']));
  assert.match(stderr, /watch not found/);
  assert.equal(exitCode, 1);
});

test('watch run: missing id exits with usage', async () => {
  const ws = workspace();
  const { stderr, exitCode } = await capture(ws, () => cmdWatchRun([]));
  assert.match(stderr, /usage/);
  assert.equal(exitCode, 2);
});
