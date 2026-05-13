import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
let tmpFakeHomedir;
let originalHome;
let originalExit;
let originalStdinIsTTY;

function setup() {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpFakeHomedir = join(
    tmpdir(),
    `robin-fakehome-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(tmpFakeHomedir, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  originalHome = process.env.HOME;
  process.env.HOME = tmpFakeHomedir;
  originalStdinIsTTY = process.stdin.isTTY;
  // Force non-interactive by default.
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
}

function cleanup() {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpFakeHomedir, { recursive: true, force: true });
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, 'HOME');
  } else {
    process.env.HOME = originalHome;
  }
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalStdinIsTTY,
    configurable: true,
  });
}

function captureExit(fn) {
  originalExit = process.exit;
  let exitCode = null;
  process.exit = (c) => {
    exitCode = c;
    throw new Error(`__test_exit__:${c}`);
  };
  return fn()
    .catch((e) => {
      if (typeof e?.message === 'string' && e.message.startsWith('__test_exit__:')) {
        return null;
      }
      throw e;
    })
    .finally(() => {
      process.exit = originalExit;
    })
    .then(() => exitCode);
}

async function importInstall() {
  return await import(`../../runtime/cli/commands/install.js?cb=${Date.now()}-${Math.random()}`);
}

function noopSupervise() {
  return async () => {};
}

// Skip the standalone-surreal install step in tests. Returning null tells
// install() to leave `db.url` out of config, so connect() falls back to
// the embedded engine — which is what these tests exercise.
async function noopSurreal() {
  return null;
}

// ---------- Argument parsing ----------

test('install --profile mxbai-1024 --no-mcp writes config and runs migrations', async () => {
  setup();
  try {
    const { install } = await importInstall();
    await install(['--profile', 'mxbai-1024', '--no-mcp'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
    assert.ok(cfg.installed_at);
  } finally {
    cleanup();
  }
});

test('install --auto --no-mcp picks mxbai-1024 defaults with no other flags', async () => {
  setup();
  try {
    const { install } = await importInstall();
    await install(['--auto', '--no-mcp'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
    assert.ok(cfg.installed_at);
  } finally {
    cleanup();
  }
});

test('install --auto --profile gemini-3072 --i-understand --no-mcp respects explicit profile', async () => {
  setup();
  try {
    const { saveSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
    saveSecret('GEMINI_API_KEY', 'fake-key-xxx');
    const { install } = await importInstall();
    await install(
      ['--auto', '--profile', 'gemini-3072', '--i-understand', '--no-mcp', '--no-migrate'],
      { supervise: noopSupervise(), surreal: noopSurreal },
    );
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'gemini-3072');
  } finally {
    cleanup();
  }
});

test('install --profile gemini-3072 --i-understand --no-mcp persists profile when key set', async () => {
  setup();
  try {
    const { saveSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
    saveSecret('GEMINI_API_KEY', 'fake-key-xxx');
    const { install } = await importInstall();
    await install(['--profile', 'gemini-3072', '--i-understand', '--no-mcp', '--no-migrate'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'gemini-3072');
  } finally {
    cleanup();
  }
});

test('install --profile gemini-3072 in non-interactive mode without --i-understand exits 1', async () => {
  setup();
  try {
    const { install } = await importInstall();
    const exitCode = await captureExit(() =>
      install(['--profile', 'gemini-3072', '--no-mcp'], {
        supervise: noopSupervise(),
        surreal: noopSurreal,
        interactive: false,
      }),
    );
    assert.equal(exitCode, 1);
    assert.ok(!existsSync(join(tmpHome, 'config', 'config.json')));
  } finally {
    cleanup();
  }
});

test('install --profile invalid-name exits 1', async () => {
  setup();
  try {
    const { install } = await importInstall();
    const exitCode = await captureExit(() =>
      install(['--profile', 'bogus-1234', '--no-mcp'], {
        supervise: noopSupervise(),
        surreal: noopSurreal,
      }),
    );
    assert.equal(exitCode, 1);
  } finally {
    cleanup();
  }
});

// ---------- Legacy ~/.robin/ detection (v4.4: replaced by chooseHome) ----------
// detectLegacyHome is gone; an empty ~/.robin/ is no longer treated as blocking.
// Only directories containing db/CURRENT or secrets/.env are detected as legacy.

test('empty ~/.robin/ no longer aborts install (proceeds without prompt)', async () => {
  setup();
  try {
    mkdirSync(join(tmpFakeHomedir, '.robin'), { recursive: true });
    const { install } = await importInstall();
    // Empty ~/.robin/ is not a recognised legacy home; install proceeds normally.
    await install(['--profile', 'mxbai-1024', '--no-mcp', '--no-migrate'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
      interactive: false,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
  } finally {
    cleanup();
  }
});

test('empty ~/.robin/ with --force proceeds non-interactively', async () => {
  setup();
  try {
    mkdirSync(join(tmpFakeHomedir, '.robin'), { recursive: true });
    const { install } = await importInstall();
    await install(['--profile', 'mxbai-1024', '--force', '--no-mcp', '--no-migrate'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
      interactive: false,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
  } finally {
    cleanup();
  }
});

test('install interactive: profile flag respected, config written', async () => {
  setup();
  try {
    const prompts = [];
    const promptFn = async (q) => {
      prompts.push(q);
      return '';
    };
    const { install } = await importInstall();
    await install(['--profile', 'mxbai-1024', '--no-mcp', '--no-migrate'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
      interactive: true,
      prompt: promptFn,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
  } finally {
    cleanup();
  }
});

// ---------- Reinstall short-circuit ----------

test('reinstall short-circuit when config exists', async () => {
  setup();
  try {
    const { writeConfig } = await import(`../../config/paths.js?cb=${Date.now()}`);
    await writeConfig({ embedder_profile: 'mxbai-1024' });
    const installedAtBefore = existsSync(join(tmpHome, 'config', 'config.json'));
    assert.ok(installedAtBefore);
    let superviseCalled = false;
    const supervise = async () => {
      superviseCalled = true;
    };
    const { install } = await importInstall();
    await install(['--profile', 'qwen3-4096', '--no-mcp'], { supervise });
    // Did NOT switch to qwen3 — short-circuited.
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
    assert.equal(superviseCalled, false);
  } finally {
    cleanup();
  }
});

test('reinstall with --force proceeds past short-circuit', async () => {
  setup();
  try {
    const { writeConfig } = await import(`../../config/paths.js?cb=${Date.now()}`);
    await writeConfig({ embedder_profile: 'mxbai-1024', installed_at: 'old' });
    const { install } = await importInstall();
    await install(['--profile', 'mxbai-1024', '--force', '--no-mcp'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
    assert.notEqual(cfg.installed_at, 'old');
  } finally {
    cleanup();
  }
});

// ---------- Per-profile validation: Ollama ----------

test('qwen3-4096 with Ollama unreachable AND binary missing exits 1', async () => {
  setup();
  try {
    const fetchFn = async () => {
      throw new Error('connection refused');
    };
    const { install } = await importInstall();
    const exitCode = await captureExit(() =>
      install(['--profile', 'qwen3-4096', '--no-mcp', '--no-migrate'], {
        supervise: noopSupervise(),
        surreal: noopSurreal,
        fetch: fetchFn,
        which: () => null,
      }),
    );
    assert.equal(exitCode, 1);
    assert.ok(!existsSync(join(tmpHome, 'config', 'config.json')));
  } finally {
    cleanup();
  }
});

test('qwen3-4096 with Ollama unreachable but binary present auto-starts daemon', async () => {
  setup();
  try {
    // First fetch fails (daemon down); after auto-start, subsequent fetches succeed.
    let started = false;
    const fetchFn = async () => {
      if (!started) throw new Error('connection refused');
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'qwen3-embedding:8b' }] }),
      };
    };
    const spawnCalls = [];
    const spawnFn = (cmd, args) => {
      spawnCalls.push([cmd, args]);
      started = true; // simulate daemon coming up
      return { unref: () => {} };
    };
    const { install } = await importInstall();
    await install(['--profile', 'qwen3-4096', '--no-mcp', '--no-migrate'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
      fetch: fetchFn,
      which: () => '/usr/local/bin/ollama',
      spawn: spawnFn,
    });
    assert.deepEqual(spawnCalls, [['ollama', ['serve']]]);
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'qwen3-4096');
  } finally {
    cleanup();
  }
});

test('qwen3-4096 with model missing auto-pulls and persists config', async () => {
  setup();
  try {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'llama3' }] }),
    });
    const pullCalls = [];
    const spawnSyncFn = (cmd, args) => {
      pullCalls.push([cmd, args]);
      return { status: 0 };
    };
    const { install } = await importInstall();
    await install(['--profile', 'qwen3-4096', '--no-mcp', '--no-migrate'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
      fetch: fetchFn,
      spawnSync: spawnSyncFn,
    });
    assert.deepEqual(pullCalls, [['ollama', ['pull', 'qwen3-embedding:8b']]]);
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'qwen3-4096');
  } finally {
    cleanup();
  }
});

test('qwen3-4096 with model missing + pull failure exits 1', async () => {
  setup();
  try {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'llama3' }] }),
    });
    const spawnSyncFn = () => ({ status: 1 });
    const { install } = await importInstall();
    const exitCode = await captureExit(() =>
      install(['--profile', 'qwen3-4096', '--no-mcp', '--no-migrate'], {
        supervise: noopSupervise(),
        surreal: noopSurreal,
        fetch: fetchFn,
        spawnSync: spawnSyncFn,
      }),
    );
    assert.equal(exitCode, 1);
    assert.ok(!existsSync(join(tmpHome, 'config', 'config.json')));
  } finally {
    cleanup();
  }
});

test('qwen3-4096 with Ollama reachable + model present persists config', async () => {
  setup();
  try {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'qwen3-embedding:8b' }] }),
    });
    const { install } = await importInstall();
    await install(['--profile', 'qwen3-4096', '--no-mcp', '--no-migrate'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
      fetch: fetchFn,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'qwen3-4096');
  } finally {
    cleanup();
  }
});

// ---------- Per-profile validation: Gemini ----------

test('gemini-3072 in non-interactive without GEMINI_API_KEY exits 1', async () => {
  setup();
  try {
    const { install } = await importInstall();
    const exitCode = await captureExit(() =>
      install(['--profile', 'gemini-3072', '--i-understand', '--no-mcp', '--no-migrate'], {
        supervise: noopSupervise(),
        surreal: noopSurreal,
        interactive: false,
      }),
    );
    assert.equal(exitCode, 1);
    assert.ok(!existsSync(join(tmpHome, 'config', 'config.json')));
  } finally {
    cleanup();
  }
});

// ---------- Config persistence ----------

test('config.json is written atomically with profile and installed_at', async () => {
  setup();
  try {
    const { install } = await importInstall();
    await install(['--profile', 'mxbai-1024', '--no-mcp', '--no-migrate'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
    });
    const cfgPath = join(tmpHome, 'config', 'config.json');
    assert.ok(existsSync(cfgPath));
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
    assert.match(cfg.installed_at, /^\d{4}-\d{2}-\d{2}T/);
    // Re-read confirms persistence.
    const { readConfig } = await import(`../../config/paths.js?cb=${Date.now()}`);
    const reread = await readConfig();
    assert.equal(reread.embedder_profile, 'mxbai-1024');
  } finally {
    cleanup();
  }
});

// ---------- Interactive prompt picks profile ----------

test('interactive prompt with default (empty input) picks mxbai-1024', async () => {
  setup();
  try {
    const promptFn = async () => '';
    const { install } = await importInstall();
    await install(['--no-mcp', '--no-migrate'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
      interactive: true,
      prompt: promptFn,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
  } finally {
    cleanup();
  }
});

// ---------- End-to-end smoke ----------

test('end-to-end: --profile mxbai-1024 --force runs migrations and writes runtime:embedder', async () => {
  setup();
  try {
    let runtimeEmbedderRow = null;
    const { install } = await importInstall();
    await install(['--profile', 'mxbai-1024', '--force', '--no-mcp'], {
      supervise: noopSupervise(),
      surreal: noopSurreal,
      onDbReady: async (db) => {
        const [rows] = await db
          .query("SELECT * FROM type::record('runtime', 'embedder');")
          .collect();
        runtimeEmbedderRow = rows;
      },
    });
    // Config written
    const cfgPath = join(tmpHome, 'config', 'config.json');
    assert.ok(existsSync(cfgPath));
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
    // DB dir exists
    assert.ok(existsSync(join(tmpHome, 'data', 'db')));
    // runtime:embedder row exists with the right profile + dimension
    assert.ok(Array.isArray(runtimeEmbedderRow));
    assert.ok(runtimeEmbedderRow.length >= 1);
    assert.equal(runtimeEmbedderRow[0].value.active_profile, 'mxbai-1024');
    assert.equal(runtimeEmbedderRow[0].value.dimension, 1024);
  } finally {
    cleanup();
  }
});

// surrealkv persists the root credential in the data dir on first start; the
// `--pass` flag is silently ignored on subsequent starts when a root user
// already exists. Previously `install()` generated a fresh random pass every
// run via `surrealInstall()`, so every re-install wrote a config + plist whose
// password no longer matched what the live db expected → auth failures. The
// fix: reuse the existing `config.json` db.pass on re-install. These tests
// pin that behaviour.
test('install rotates db.pass on a fresh install (no prior config)', async () => {
  setup();
  try {
    const surrealCalls = [];
    const surrealMock = async (opts) => {
      surrealCalls.push(opts);
      return {
        url: 'ws://127.0.0.1:8000',
        user: 'root',
        pass: opts.pass ?? 'generated-fresh-pass',
      };
    };
    const { install } = await importInstall();
    await install(['--profile', 'mxbai-1024', '--no-mcp', '--no-migrate', '--no-hooks'], {
      supervise: noopSupervise(),
      surreal: surrealMock,
    });
    assert.equal(surrealCalls.length, 1);
    assert.equal(surrealCalls[0].pass, undefined, 'fresh install should not pin a pass');
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8'));
    assert.equal(cfg.db.pass, 'generated-fresh-pass');
  } finally {
    cleanup();
  }
});

test('install reuses existing db.pass on re-install (no rotation)', async () => {
  setup();
  try {
    const surrealCalls = [];
    const surrealMock = async (opts) => {
      surrealCalls.push(opts);
      return {
        url: 'ws://127.0.0.1:8000',
        user: 'root',
        // Simulate surrealInstall's real behaviour: when caller pins `pass`,
        // it honours it; otherwise it generates one.
        pass: opts.pass ?? `gen-${surrealCalls.length}`,
      };
    };
    const { install } = await importInstall();

    // First install — surreal generates a pass, install persists it.
    await install(['--profile', 'mxbai-1024', '--no-mcp', '--no-migrate', '--no-hooks'], {
      supervise: noopSupervise(),
      surreal: surrealMock,
    });
    const firstPass = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8')).db
      .pass;
    assert.ok(firstPass);

    // Re-install with --force. Should pin surreal's `pass` to firstPass.
    const { install: install2 } = await importInstall();
    await install2(
      [
        '--profile',
        'mxbai-1024',
        '--no-mcp',
        '--no-migrate',
        '--no-hooks',
        '--force',
        '--on-existing',
        'ignore',
      ],
      { supervise: noopSupervise(), surreal: surrealMock },
    );

    assert.equal(surrealCalls.length, 2, 'surreal mock called once per install');
    assert.equal(
      surrealCalls[1].pass,
      firstPass,
      're-install must pass existing pass through so surreal does not rotate',
    );

    const finalPass = JSON.parse(readFileSync(join(tmpHome, 'config', 'config.json'), 'utf-8')).db
      .pass;
    assert.equal(finalPass, firstPass, 'config.json db.pass must remain stable across re-install');
  } finally {
    cleanup();
  }
});
