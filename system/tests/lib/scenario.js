// system/tests/lib/scenario.js
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

import { installClock, uninstallClock } from './clock.js';
import { installRandom, uninstallRandom } from './ids.js';
import { installStubs, uninstallStubs, getLedger, hasBlockEvents } from './stubs.js';
import { seedFixture, makeTempdir, cleanupTempdir } from './fixtures.js';
import { captureTree, compareTrees, writeTreeAtomic, loadExpectedTree, formatDiff } from './snapshot.js';
import { normalize } from './normalize.js';
import { ExitSignal } from '../../scripts/lib/exit-signal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const FIXTURES_DIR = join(REPO_ROOT, 'system/tests/fixtures');

const DEFAULT_TREE_IGNORE = [
  'user-data/runtime/state/telemetry/**',
  'user-data/runtime/state/jobs/**/*.lock',
  'user-data/runtime/state/jobs/**/*.tmp',
  '**/.DS_Store',
];

const SUBSYSTEM_DEFAULT_MODE = {
  hooks: 'subprocess',
  install: 'subprocess',
};

function pickDefaultMode(fixturePath) {
  const subsystem = fixturePath.split('/')[0];
  return SUBSYSTEM_DEFAULT_MODE[subsystem] ?? 'inproc';
}

function substituteTempdir(envOverlay, tempdir) {
  const out = {};
  for (const [k, v] of Object.entries(envOverlay ?? {})) {
    out[k] = String(v).replace(/__TEMPDIR__/g, tempdir);
  }
  return out;
}

function scenarioEnvFor(tempdir, fixture, clock) {
  return {
    ROBIN_WORKSPACE: tempdir,
    ROBIN_CLOCK: clock,
    ROBIN_RANDOM_SEED: fixture,
  };
}

function mapValues(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out;
}

export async function runScenario(opts) {
  const {
    fixture,
    steps,
    clock = '2026-01-01T00:00:00Z',
    seed = 'none',
    mode = pickDefaultMode(fixture),
    expect = { tree: true, io: false, network: false },
    normalize: extraNormalizers = [],
    stubs = { fetch: [] },
  } = opts;

  const fixtureDir = join(FIXTURES_DIR, fixture);
  if (!existsSync(fixtureDir)) {
    throw new Error(`fixture not found: ${fixtureDir}`);
  }

  const tempdir = makeTempdir();
  let success = false;

  try {
    seedFixture({ fixtureDir, seed, tempdir, repoRoot: REPO_ROOT });

    const ioCaptures = [];
    const baseEnv = scenarioEnvFor(tempdir, fixture, clock);

    // Snapshot of inproc-mode block events, captured BEFORE uninstallStubs()
    // clears the ledger. (Bug fix: previously this lived after the finally
    // and read empty state.)
    let blockSummary = null;

    if (mode === 'inproc') {
      installClock(clock);
      installRandom(fixture);
      installStubs(stubs);
      const realExit = process.exit;
      process.exit = (code) => { throw new ExitSignal(code ?? 0); };

      try {
        for (let i = 0; i < steps.length; i++) {
          ioCaptures.push(await runInprocStep(steps[i], { tempdir, baseEnv }));
        }
      } finally {
        // Capture ledger state before tearing down stubs.
        blockSummary = { hasBlocks: hasBlockEvents(), ledger: getLedger() };
        process.exit = realExit;
        uninstallStubs();
        uninstallRandom();
        uninstallClock();
      }
    } else {
      // subprocess mode
      const stubsFile = join(tempdir, '.stubs.json');
      writeFileSync(stubsFile, JSON.stringify(stubs));
      for (let i = 0; i < steps.length; i++) {
        ioCaptures.push(runSubprocessStep(steps[i], { tempdir, baseEnv, stubsFile }));
      }
    }

    // Block-event guard: any unstubbed call attempted in inproc → fail.
    if (blockSummary && blockSummary.hasBlocks) {
      throw new Error(`Scenario attempted unstubbed outbound calls. Ledger: ${JSON.stringify(blockSummary.ledger, null, 2)}`);
    }

    // Tree assertion / write.
    const ctx = { workspace: tempdir, clockMs: Date.parse(clock), extra: extraNormalizers };
    const expectTreeOpt = expect.tree;
    const ignoreInput = (expectTreeOpt && typeof expectTreeOpt === 'object' && expectTreeOpt.ignore) || [];
    const ignore = [...DEFAULT_TREE_IGNORE, ...ignoreInput];
    // captureTree walks a single root; we walk the user-data subtree.
    // Convert ignore globs that are anchored at user-data/ to be anchored at the userdata root.
    const userDataRoot = join(tempdir, 'user-data');
    const userDataIgnore = ignore.map((g) => g.startsWith('user-data/') ? g.slice('user-data/'.length) : g);
    const actualTreeRaw = captureTree(userDataRoot, userDataIgnore);
    // captureTree returns relpaths relative to userDataRoot — we want relpaths
    // prefixed with `user-data/` for stability with expected/tree/user-data/...
    const actualTree = mapValues(actualTreeRaw, (v) => normalize(v, ctx));
    const actualTreePrefixed = {};
    for (const [k, v] of Object.entries(actualTree)) {
      actualTreePrefixed[`user-data/${k}`] = v;
    }

    const expectedTreeDir = join(fixtureDir, 'expected/tree');

    if (expect.tree) {
      if (process.env.UPDATE_SNAPSHOTS === '1') {
        writeTreeAtomic(expectedTreeDir, actualTreePrefixed);
      } else {
        const expectedTree = loadExpectedTree(expectedTreeDir);
        const diff = compareTrees(actualTreePrefixed, expectedTree);
        if (diff.missing.length || diff.unexpected.length || diff.contentDiffs.length) {
          const out = [
            ``,
            `scenario: ${fixture}`,
            `tempdir (preserved): ${tempdir}`,
            formatDiff(diff),
            ``,
          ].join('\n');
          throw new Error(out);
        }
      }
    }

    // IO and network — exit codes always asserted; full IO/ledger only when opted in.
    for (let i = 0; i < steps.length; i++) {
      const expected = steps[i].expectExit ?? 0;
      assert.equal(ioCaptures[i].exitCode, expected, `step ${i}: expected exit ${expected}, got ${ioCaptures[i].exitCode}`);
    }

    if (expect.io) {
      const ioPath = join(fixtureDir, 'expected/io.snapshot.json');
      const normalizedIo = ioCaptures.map((c, i) => ({
        step: i,
        exitCode: c.exitCode,
        stdout: normalize(c.stdout ?? '', ctx),
        stderr: normalize(c.stderr ?? '', ctx),
      }));
      if (process.env.UPDATE_SNAPSHOTS === '1') {
        writeFileSync(ioPath, JSON.stringify(normalizedIo, null, 2));
      } else {
        const expected = JSON.parse(readFileSync(ioPath, 'utf8'));
        assert.deepEqual(normalizedIo, expected, `IO mismatch in scenario ${fixture}`);
      }
    }

    if (expect.network) {
      const netPath = join(fixtureDir, 'expected/network.json');
      const ledger = getLedger();
      if (process.env.UPDATE_SNAPSHOTS === '1') {
        writeFileSync(netPath, JSON.stringify(ledger, null, 2));
      } else {
        const expected = JSON.parse(readFileSync(netPath, 'utf8'));
        assert.deepEqual(ledger, expected, `Network ledger mismatch in scenario ${fixture}`);
      }
    }

    success = true;
  } finally {
    cleanupTempdir(tempdir, success);
  }
}

async function runInprocStep(step, { tempdir, baseEnv }) {
  const stepEnv = substituteTempdir(step.env, tempdir);
  const env = { ...baseEnv, ...stepEnv };

  // Save and overlay process.env for the step.
  const savedEnv = { ...process.env };
  Object.assign(process.env, env);

  const stdoutBuf = [];
  const stderrBuf = [];
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { stdoutBuf.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderrBuf.push(String(chunk)); return true; };

  let exitCode = 0;
  try {
    if (step.run) {
      const { main } = await import('../../../bin/robin.js');
      try {
        const r = await main(step.run, env);
        exitCode = r.exitCode;
      } catch (e) {
        if (e instanceof ExitSignal) exitCode = e.code;
        else throw e;
      }
    } else if (step.hook) {
      const { runHook } = await import('../../scripts/hooks/claude-code.js');
      try {
        const r = await runHook(step.hook, { stdin: step.stdin ?? null, env, workspace: tempdir });
        exitCode = r.exitCode;
      } catch (e) {
        if (e instanceof ExitSignal) exitCode = e.code;
        else throw e;
      }
    } else if (step.writeFile) {
      const filePath = join(tempdir, step.writeFile);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, step.content ?? '');
    } else {
      throw new Error(`unknown step: ${JSON.stringify(step)}`);
    }
  } finally {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    // Restore env.
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }

  return { exitCode, stdout: stdoutBuf.join(''), stderr: stderrBuf.join('') };
}

function runSubprocessStep(step, { tempdir, baseEnv, stubsFile }) {
  const stepEnv = substituteTempdir(step.env, tempdir);
  const env = {
    ...process.env,
    ...baseEnv,
    ROBIN_STUBS_FILE: stubsFile,
    ...stepEnv,
  };
  const preloads = [
    '--import', join(REPO_ROOT, 'system/tests/lib/preload-clock.mjs'),
    '--import', join(REPO_ROOT, 'system/tests/lib/preload-random.mjs'),
    '--import', join(REPO_ROOT, 'system/tests/lib/preload-stubs.mjs'),
  ];

  let nodeArgs;
  let stdinInput;
  if (step.run) {
    nodeArgs = [...preloads, join(REPO_ROOT, 'bin/robin.js'), ...step.run];
    stdinInput = '';
  } else if (step.hook) {
    nodeArgs = [...preloads, join(REPO_ROOT, 'system/scripts/hooks/claude-code.js'), `--${step.hook}`, '--workspace', tempdir];
    stdinInput = JSON.stringify(step.stdin ?? {});
  } else if (step.writeFile) {
    const filePath = join(tempdir, step.writeFile);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, step.content ?? '');
    return { exitCode: 0, stdout: '', stderr: '' };
  } else {
    throw new Error(`unknown step: ${JSON.stringify(step)}`);
  }

  const r = spawnSync('node', nodeArgs, { env, input: stdinInput, encoding: 'utf8' });
  return {
    // r.status is null when killed by signal — surface that as exit 1 rather
    // than papering over with 0, which would silently turn a SIGTERM-killed
    // subprocess into an apparent success.
    exitCode: r.status ?? (r.signal ? 1 : 0),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}
