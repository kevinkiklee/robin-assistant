import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { writeConfig } from '../../config/paths.js';

// __robin_test_home_setup__
const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const { doctor } = await import('../../runtime/cli/commands/doctor.js');
const { packageRootDir } = await import('../../config/data-store.js');
const { close: __close, connect: __connect } = await import('../../data/db/client.js');
const { runMigrations: __runMigrations } = await import('../../data/db/migrate.js');

async function __openMemDbWithMigrations() {
  const db = await __connect({ engine: 'mem://' });
  await __runMigrations(db, join(packageRootDir(), 'system', 'data', 'db', 'migrations'));
  return db;
}

function makeOutCapture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('doctor: no flags prints status overview', async () => {
  const o = makeOutCapture();
  const e = makeOutCapture();
  await doctor([], { out: o.fn, err: e.fn });
  const all = o.lines.join('\n');
  assert.match(all, /ROBIN_HOME:/);
  assert.match(all, /manifest:/);
  assert.match(all, /daemon:/);
  assert.match(all, /secrets file:/);
  assert.match(all, /config:/);
});

test('doctor --rebaseline: writes manifest.json', async () => {
  const o = makeOutCapture();
  const e = makeOutCapture();
  await doctor(['--rebaseline'], { out: o.fn, err: e.fn });
  const manifestPath = join(__robinTestHome, 'runtime', 'install', 'manifest.json');
  assert.ok(existsSync(manifestPath), 'manifest must exist after rebaseline');
  const all = o.lines.join('\n');
  assert.match(all, /introspection baseline rewritten/);
});

test('doctor --lint-hooks: lists robin-owned entries from settings.json', async () => {
  const fakeHome = join(__robinTestHome, 'fake-user-home');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  mkdirSync(join(fakeHome, '.gemini'), { recursive: true });

  const shimPath = join(packageRootDir(), 'system', 'bin', 'robin-hook.sh');
  const claudeSettings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `${shimPath} discretion` }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${shimPath} intuition` }] }],
      // Foreign entry — should NOT be listed.
      SessionStart: [{ hooks: [{ type: 'command', command: '/usr/bin/some-other-tool foo' }] }],
    },
  };
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify(claudeSettings, null, 2),
  );

  const geminiSettings = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `${shimPath} session-start` }] }],
    },
  };
  writeFileSync(
    join(fakeHome, '.gemini', 'settings.json'),
    JSON.stringify(geminiSettings, null, 2),
  );

  const o = makeOutCapture();
  const e = makeOutCapture();
  await doctor(['--lint-hooks'], { out: o.fn, err: e.fn, homeDir: fakeHome });
  const all = o.lines.join('\n');
  assert.match(all, /claude: PreToolUse/);
  assert.match(all, /claude: UserPromptSubmit/);
  assert.match(all, /gemini: SessionStart/);
  assert.doesNotMatch(all, /some-other-tool/);
  assert.match(all, /total robin-owned hook entries: 3/);
});

test('doctor --lint-hooks: no settings.json prints empty', async () => {
  const fakeHome = join(__robinTestHome, 'empty-home');
  mkdirSync(fakeHome, { recursive: true });
  const o = makeOutCapture();
  const e = makeOutCapture();
  await doctor(['--lint-hooks'], { out: o.fn, err: e.fn, homeDir: fakeHome });
  const all = o.lines.join('\n');
  assert.match(all, /claude: no settings\.json or no hooks/);
  assert.match(all, /gemini: no settings\.json or no hooks/);
  assert.match(all, /total robin-owned hook entries: 0/);
});

test('doctor status: db.url=ws → probeSurreal output appears, engine line says "remote"', async () => {
  // Rewrite config to point at a ws:// URL for the duration of this test.
  await writeConfig({
    embedder_profile: 'mxbai-1024',
    db: { url: 'ws://127.0.0.1:8000', user: 'root', pass: 'fake' },
  });
  try {
    const o = makeOutCapture();
    const e = makeOutCapture();
    await doctor([], {
      out: o.fn,
      err: e.fn,
      probeSurreal: async (httpUrl) => ({
        ok: true,
        message: `reachable at ${httpUrl} (HTTP 200)`,
      }),
    });
    const all = o.lines.join('\n');
    assert.match(all, /surreal server: reachable at http:\/\/127\.0\.0\.1:8000/);
    assert.match(all, /engine: ws \(remote — on-disk format owned by surreal server\)/);
    // Should NOT emit the destructive-reset false alarm for ws-mode.
    assert.doesNotMatch(all, /destructive reset required/);
  } finally {
    await writeConfig({ embedder_profile: 'mxbai-1024' });
  }
});

test('doctor status: better-sqlite3 ABI mismatch surfaces fix-it hint', async () => {
  const o = makeOutCapture();
  const e = makeOutCapture();
  await doctor([], {
    out: o.fn,
    err: e.fn,
    probeBetterSqlite3: async () => ({
      ok: false,
      message: 'native bindings: better-sqlite3 ABI mismatch',
      details: ['fix: npm rebuild better-sqlite3'],
    }),
  });
  const all = o.lines.join('\n');
  assert.match(all, /better-sqlite3 ABI mismatch/);
  assert.match(all, /npm rebuild better-sqlite3/);
});

test('doctor status: supervisor probe surfaces launchctl/systemctl status', async () => {
  const o = makeOutCapture();
  const e = makeOutCapture();
  await doctor([], {
    out: o.fn,
    err: e.fn,
    probeSupervisor: () => ({ status: 'loaded' }),
  });
  assert.match(o.lines.join('\n'), /supervisor: loaded/);
});

test('doctor status: integration freshness rollup names stale integrations', async () => {
  const o = makeOutCapture();
  const e = makeOutCapture();
  await doctor([], {
    out: o.fn,
    err: e.fn,
    probeIntegrationFreshness: async () => ({
      total: 3,
      stale: 2,
      stale_names: ['gmail', 'spotify'],
    }),
  });
  assert.match(o.lines.join('\n'), /integrations: 2\/3 stale.*gmail, spotify/);
});

test('doctor status: biographer.log surfaces last error line', async () => {
  const o = makeOutCapture();
  const e = makeOutCapture();
  await doctor([], {
    out: o.fn,
    err: e.fn,
    probeBiographerLog: () => ({
      exists: true,
      size: 1234,
      tail_lines: 50,
      error_lines: 2,
      last_error: 'Error: connection lost to host',
      mtime: '2026-05-10T00:00:00.000Z',
    }),
  });
  const all = o.lines.join('\n');
  assert.match(all, /biographer\.log: 50 recent lines, 2 flagged/);
  assert.match(all, /last error: Error: connection lost/);
});

test('doctor --purge-stale-sessions: returns count without erroring', async () => {
  // Inject a mem:// db so we don't pull in the rocksdb store (which has a
  // known close-hang in @surrealdb/node v3.0.3 under tests).
  const o = makeOutCapture();
  const e = makeOutCapture();
  await doctor(['--purge-stale-sessions'], {
    out: o.fn,
    err: e.fn,
    openDb: __openMemDbWithMigrations,
    closeDb: __close,
  });
  const all = o.lines.join('\n');
  assert.match(all, /purged \d+ stale sessions/);
});
