import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./private-scan.mjs', import.meta.url));
const HAS_DICT = existsSync('/usr/share/dict/words') || existsSync('/usr/dict/words');

/** A scratch repo + user-data with an operator profile and a memory DB. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'robin-pscan-'));
  const repo = join(root, 'repo');
  const ud = join(root, 'ud');
  mkdirSync(repo);
  mkdirSync(join(ud, 'config'), { recursive: true });
  mkdirSync(join(ud, 'state', 'db'), { recursive: true });
  writeFileSync(
    join(ud, 'config', 'operator.yaml'),
    'name: Quill Operator\naliases: [qop]\nprivate_terms: [Zephyrton]\n',
  );
  execFileSync('sqlite3', [
    join(ud, 'state', 'db', 'robin.sqlite'),
    "CREATE TABLE entities (type TEXT, canonical_name TEXT); INSERT INTO entities VALUES ('person','Wilhelmina Fakeworth'),('person','Grant Fakeworth'),('medication','fakeprin'),('financial_account','Fakebank Checking ⋯7311');", // privacy-scan:allow
  ]);
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  return { repo, ud, g };
}

function scan(repo: string, ud: string, ...args: string[]) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ROBIN_USER_DATA_DIR: ud },
  });
  return { code: r.status, out: r.stderr };
}

test('private-scan --staged: blocks profile terms, memory names, and personal shapes', () => {
  const { repo, ud, g } = fixture();
  const cases: Array<[string, RegExp]> = [
    ['// ask Quill about it', /term: Quill/],
    ['const handle = "qop";', /term: qop/],
    ['trip to Zephyrton', /term: Zephyrton/],
    ["upsertEntity(db, 'person', 'Wilhelmina Fakeworth')", /term: Wilhelmina Fakeworth/],
    ['takes fakeprin mornings', /term: fakeprin/],
    ['call 415-282-0199 later', /phone: 415-282-0199/], // privacy-scan:allow
    ['mail jo.fake@gmail.com', /personal-email/], // privacy-scan:allow
    ['card ending in 7311', /account-last4: ending in 7311/], // privacy-scan:allow
  ];
  for (const [line, expected] of cases) {
    writeFileSync(join(repo, 'f.ts'), `${line}\n`);
    g('add', 'f.ts');
    const r = scan(repo, ud, '--staged');
    assert.equal(r.code, 1, line);
    assert.match(r.out, expected, line);
  }
});

test('private-scan --staged: fictional and placeholder values pass', () => {
  const { repo, ud, g } = fixture();
  writeFileSync(
    join(repo, 'f.ts'),
    [
      "const who = 'Sam Rivera';", // fictional
      'call (555) 555-0142', // 555 = fictional exchange
      'mail sam@example.com',
      'card ending in 1234 or ⋯0000',
      'call 415-282-0199 // privacy-scan:allow', // privacy-scan:allow
    ]
      // Dictionary words that start a person entity's name are skipped — only where the
      // host has a word list (macOS does; CI's Ubuntu image doesn't, so it errs strict).
      .concat(HAS_DICT ? ['a grant for the baker'] : [])
      .join('\n'),
  );
  g('add', 'f.ts');
  assert.deepEqual(scan(repo, ud, '--staged'), { code: 0, out: '' });
});

test('private-scan --range: only lines added in the range are checked', () => {
  const { repo, ud, g } = fixture();
  writeFileSync(join(repo, 'a.ts'), 'clean\n');
  g('add', 'a.ts');
  g('commit', '-qm', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'a.ts'), 'clean\nnew line names Zephyrton\n');
  g('commit', '-qam', 'leak', '--no-verify');
  writeFileSync(join(repo, 'a.ts'), 'clean\n');
  g('commit', '-qam', 'remove it again', '--no-verify');
  // Net diff is empty, but the leaking commit is still in what gets pushed.
  const r = scan(repo, ud, '--range', base, 'HEAD');
  assert.equal(r.code, 1);
  assert.match(r.out, /a\.ts @[0-9a-f]{7}:2: term: Zephyrton/);
});

test('private-scan --range: commit messages and author identities are checked', () => {
  const { repo, ud, g } = fixture();
  writeFileSync(join(repo, 'a.ts'), 'clean\n');
  g('add', 'a.ts');
  g('commit', '-qm', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'a.ts'), 'still clean\n');
  g('add', 'a.ts');
  execFileSync('git', ['commit', '-qm', 'fix: chat with Wilhelmina Fakeworth', '--no-verify'], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_EMAIL: 'jo.fake@gmail.com' }, // privacy-scan:allow
  });
  const r = scan(repo, ud, '--range', base, 'HEAD');
  assert.equal(r.code, 1);
  assert.match(r.out, /\(message\/author\).*term: Wilhelmina Fakeworth/);
  assert.match(r.out, /\(message\/author\).*personal-email/);
});

test('private-scan: no profile and no memory → nothing to match, exit 0', () => {
  const { repo, g } = fixture();
  writeFileSync(join(repo, 'f.ts'), 'call 555-0100\n');
  g('add', 'f.ts');
  const empty = mkdtempSync(join(tmpdir(), 'robin-pscan-empty-'));
  assert.equal(scan(repo, empty, '--staged').code, 0);
});

test('private-scan: a line copying the operator’s own notes is caught when added', () => {
  const { repo, ud, g } = fixture();
  mkdirSync(join(ud, 'content', 'profile'), { recursive: true });
  writeFileSync(
    join(ud, 'content', 'profile', 'prefs.md'),
    'Quill alphabetizes the spice rack every Sunday before lunch.\n',
  );
  mkdirSync(join(ud, 'content', 'knowledge'), { recursive: true });
  writeFileSync(
    join(ud, 'content', 'knowledge', 'quill-diary.md'),
    'Swam the cold lagoon at dawn twice weekly.\n',
  );
  writeFileSync(
    join(ud, 'config', 'operator.yaml'),
    'name: Quill Operator\nprivate_sources:\n  - content/knowledge/quill-*.md\n',
  );
  // No name, no shape — just the operator's own sentence.
  writeFileSync(join(repo, 'f.ts'), "const note = 'alphabetizes the spice rack every sunday';\n");
  g('add', 'f.ts');
  const r = scan(repo, ud, '--staged');
  assert.equal(r.code, 1);
  assert.match(r.out, /copied-memory-text: "alphabetizes the spice rack every sunday"/);
  // A private_sources glob is honoured too.
  writeFileSync(join(repo, 'f.ts'), '// swam the cold lagoon at dawn twice weekly\n');
  g('add', 'f.ts');
  assert.match(scan(repo, ud, '--staged').out, /copied-memory-text/);
  // Unrelated prose passes; whole-tree copied-text matching is opt-in (--deep).
  writeFileSync(join(repo, 'f.ts'), "const note = 'retry the request after a short delay';\n");
  g('add', 'f.ts');
  assert.equal(scan(repo, ud, '--staged').code, 0);
});

test('private-scan: deployment hostnames from the secrets file are private; apex and public APIs are not', () => {
  const { repo, ud, g } = fixture();
  mkdirSync(join(ud, 'config', 'secrets'), { recursive: true });
  writeFileSync(
    join(ud, 'config', 'secrets', '.env'),
    [
      'TUNNEL_PUBLIC_URL=https://relay.quillsite.test/mcp',
      'SITE_URL="https://quillsite.test"',
      'LLM_BASE_URL=https://api.anthropic.com/v1',
      'LOCAL_URL=http://127.0.0.1:41273',
      'API_TOKEN=not-a-url',
    ].join('\n'),
  );
  writeFileSync(join(repo, 'f.ts'), "const origin = 'https://relay.quillsite.test';\n");
  g('add', 'f.ts');
  const r = scan(repo, ud, '--staged');
  assert.equal(r.code, 1);
  assert.match(r.out, /term: relay\.quillsite\.test/);
  assert.ok(!r.out.includes('not-a-url'), 'secret values are never printed');
  writeFileSync(
    join(repo, 'f.ts'),
    "const site = 'https://quillsite.test'; const api = 'https://api.anthropic.com';\n",
  );
  g('add', 'f.ts');
  assert.equal(scan(repo, ud, '--staged').code, 0);
});
