import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASH_DENY_PATTERNS, checkBashCommand } from '../../cognition/discretion/bash-patterns.js';

// Sanity: 7 rules total per Phase 4a §5.A.
test('BASH_DENY_PATTERNS has the expected 7 rules', () => {
  const names = BASH_DENY_PATTERNS.map((r) => r.name).sort();
  assert.deepEqual(names, [
    'db-direct-access',
    'destructive-rm',
    'env-dump',
    'eval-injection',
    'git-expose-userdata',
    'low-level-fs',
    'secrets-read',
  ]);
});

// Table-driven cases. Each rule has at least one positive (should block,
// asserts rule name) and one negative (should not block).
const cases = [
  // ---- secrets-read ---------------------------------------------------
  {
    label: 'secrets-read: cat user-data/secrets/.env',
    cmd: 'cat user-data/secrets/.env',
    expect: 'secrets-read',
  },
  {
    label: 'secrets-read: grep within user-data/secrets/',
    cmd: 'grep API_KEY user-data/secrets/integrations.env',
    expect: 'secrets-read',
  },
  {
    label: 'secrets-read: tail .env in arbitrary path',
    cmd: 'tail -n 5 ./project/.env',
    expect: 'secrets-read',
  },
  {
    label: 'secrets-read: negative — reading docs about env vars',
    cmd: 'cat docs/env-setup.md',
    expect: null,
  },
  {
    label: 'secrets-read: negative — old runtime/secrets path no longer matches v2',
    // v1 matched user-data/runtime/secrets/; v2 only matches user-data/secrets/.
    // This string contains user-data/runtime/secrets/ which is NOT a v2 path,
    // so it should not be flagged by v2's narrowed regex.
    cmd: 'cat archive/user-data/runtime/secrets/foo.txt',
    expect: null,
  },

  // ---- env-dump -------------------------------------------------------
  {
    label: 'env-dump: bare env',
    cmd: 'env',
    expect: 'env-dump',
  },
  {
    label: 'env-dump: printenv piped to grep',
    cmd: 'printenv | grep TOKEN',
    expect: 'env-dump',
  },
  {
    label: 'env-dump: negative — env command word inside string is fine',
    cmd: 'echo "set up environment vars first"',
    expect: null,
  },
  {
    label: 'env-dump: env > file (redirect counts as dump)',
    cmd: 'env > /tmp/snapshot',
    expect: 'env-dump',
  },
  {
    label: 'env-dump: negative — env VAR=val cmd (set-and-run)',
    cmd: 'env FOO=bar node script.js',
    expect: null,
  },
  {
    label: 'env-dump: negative — env -i clean-env-then-run',
    cmd: 'env -i HOME=/tmp /bin/bash',
    expect: null,
  },
  {
    label: 'env-dump: negative — launchctl setenv is not a dump',
    cmd: 'launchctl setenv OLLAMA_KEEP_ALIVE 2h',
    expect: null,
  },
  {
    label: 'env-dump: negative — launchctl getenv is not a dump',
    cmd: 'launchctl getenv OLLAMA_API_BASE',
    expect: null,
  },
  {
    label: 'env-dump: negative — echo with literal " env " inside string is fine',
    cmd: 'echo "launchctl env set"',
    expect: null,
  },

  // ---- destructive-rm -------------------------------------------------
  {
    label: 'destructive-rm: rm -rf /tmp/foo',
    cmd: 'rm -rf /tmp/foo',
    expect: 'destructive-rm',
  },
  {
    label: 'destructive-rm: rm -fr also flagged',
    cmd: 'rm -fr build/',
    expect: 'destructive-rm',
  },
  {
    label: 'destructive-rm: long flags --recursive --force',
    cmd: 'rm --recursive --force ./tmp',
    expect: 'destructive-rm',
  },
  {
    label: 'destructive-rm: negative — rm of single file',
    cmd: 'rm ./scratch.txt',
    expect: null,
  },

  // ---- low-level-fs ---------------------------------------------------
  {
    label: 'low-level-fs: dd if=/dev/zero',
    cmd: 'dd if=/dev/zero of=/dev/sda bs=1M',
    expect: 'low-level-fs',
  },
  {
    label: 'low-level-fs: mkfs.ext4',
    cmd: 'mkfs.ext4 /dev/sdb1',
    expect: 'low-level-fs',
  },
  {
    label: 'low-level-fs: shred',
    cmd: 'shred -u secret.bin',
    expect: 'low-level-fs',
  },
  {
    label: 'low-level-fs: negative — words that contain dd as substring',
    // The regex requires `dd` as a standalone token (preceded by start/space/
    // pipe/semicolon/&, followed by space/$/pipe), so substrings like "add"
    // or "addr" must not match.
    cmd: 'echo "added a new addr field"',
    expect: null,
  },
  {
    label: 'low-level-fs: negative — pnpm format (not a disk operation on Unix)',
    cmd: 'pnpm format',
    expect: null,
  },
  {
    label: 'low-level-fs: negative — npm run format',
    cmd: 'npm run format',
    expect: null,
  },
  {
    label: 'low-level-fs: negative — biome format',
    cmd: 'biome format --write .',
    expect: null,
  },

  // ---- git-expose-userdata --------------------------------------------
  {
    label: 'git-expose-userdata: git log against user-data',
    cmd: 'git log -- user-data/memory/',
    expect: 'git-expose-userdata',
  },
  {
    label: 'git-expose-userdata: git diff user-data/secrets/',
    cmd: 'git diff HEAD~3 user-data/secrets/',
    expect: 'git-expose-userdata',
  },
  {
    label: 'git-expose-userdata: negative — git status (no exposure)',
    cmd: 'git status',
    expect: null,
  },
  {
    label: 'git-expose-userdata: negative — git log of unrelated path',
    cmd: 'git log -- src/index.js',
    expect: null,
  },

  // ---- eval-injection -------------------------------------------------
  {
    label: 'eval-injection: bare eval foo',
    cmd: 'eval "$cmd"',
    expect: 'eval-injection',
  },
  {
    label: 'eval-injection: nested $( $( ... ))',
    cmd: 'echo $( $(cat /etc/hostname) )',
    expect: 'eval-injection',
  },
  {
    label: 'eval-injection: negative — evaluation in prose',
    cmd: 'echo "evaluation in progress"',
    expect: null,
  },

  // ---- db-direct-access (NEW) -----------------------------------------
  {
    label: 'db-direct-access: surreal sql against legacy user-data/db/',
    cmd: 'surreal sql --conn rocksdb://user-data/db/main',
    expect: 'db-direct-access',
  },
  {
    label: 'db-direct-access: surreal sql against canonical user-data/data/db/',
    cmd: 'surreal sql --conn rocksdb://user-data/data/db/main',
    expect: 'db-direct-access',
  },
  {
    label: 'db-direct-access: surreal connect against $ROBIN_HOME/db/',
    cmd: 'surreal connect rocksdb://$ROBIN_HOME/db/main',
    expect: 'db-direct-access',
  },
  {
    label: 'db-direct-access: surreal connect against $ROBIN_HOME/data/db/',
    cmd: 'surreal connect rocksdb://$ROBIN_HOME/data/db/main',
    expect: 'db-direct-access',
  },
  {
    label: 'db-direct-access: surreal export from .robin/db/',
    cmd: 'surreal export --conn rocksdb://.robin/db/main backup.surql',
    expect: 'db-direct-access',
  },
  {
    label: 'db-direct-access: surreal import via /usr/local/bin/surreal (legacy path)',
    cmd: '/usr/local/bin/surreal import --conn rocksdb://user-data/db/main dump.surql',
    expect: 'db-direct-access',
  },
  {
    label: 'db-direct-access: surreal import via /usr/local/bin/surreal (canonical path)',
    cmd: '/usr/local/bin/surreal import --conn rocksdb://user-data/data/db/main dump.surql',
    expect: 'db-direct-access',
  },
  {
    label: 'db-direct-access: negative — surreal start (not a deny verb)',
    cmd: 'surreal start --bind 127.0.0.1:8000 rocksdb://user-data/db/main',
    expect: null,
  },
  {
    label: 'db-direct-access: negative — surreal sql against remote URL',
    cmd: 'surreal sql --conn https://example.com',
    expect: null,
  },
  {
    label: 'db-direct-access: negative — talking about surreal in echo',
    cmd: 'echo "surreal sql is fun"',
    expect: null,
  },
];

for (const c of cases) {
  test(c.label, () => {
    const r = checkBashCommand(c.cmd);
    if (c.expect === null) {
      assert.equal(r.blocked, false, `expected no block; got ${JSON.stringify(r)}`);
    } else {
      assert.equal(r.blocked, true, `expected block; got ${JSON.stringify(r)}`);
      assert.equal(r.name, c.expect);
      assert.equal(typeof r.why, 'string');
    }
  });
}

// Edge cases on the input itself.
test('checkBashCommand: empty string is not blocked', () => {
  assert.deepEqual(checkBashCommand(''), { blocked: false });
});

test('checkBashCommand: non-string input is not blocked', () => {
  assert.deepEqual(checkBashCommand(undefined), { blocked: false });
  assert.deepEqual(checkBashCommand(null), { blocked: false });
  assert.deepEqual(checkBashCommand(42), { blocked: false });
});

test('checkBashCommand: first-match-wins ordering', () => {
  // A command that could match multiple patterns; secrets-read appears
  // before env-dump in the array, so secrets-read wins.
  const r = checkBashCommand('cat .env && env');
  assert.equal(r.blocked, true);
  assert.equal(r.name, 'secrets-read');
});
