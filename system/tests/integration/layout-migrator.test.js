// tests/integration/layout-migrator.test.js
//
// Exercises the v1→v2 user-data layout migration end-to-end against synthetic
// tmpdir homes. Covers:
//   - Detection across (fresh | v1 | v2) states.
//   - Full migration of a populated v1 layout.
//   - Daemon-running guard refuses to migrate.
//   - Stale lockfile gets stolen on the next call.
//   - "Both old and new non-empty" conflict aborts cleanly.
//   - Idempotency: second call on a v2 home is a no-op.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  detectLayoutVersion,
  migrateUserDataLayout,
} from '../../runtime/install/layout-migrator.js';

function freshHome(label) {
  const h = join(
    tmpdir(),
    `robin-layout-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(h, { recursive: true });
  return h;
}

// Build a populated v1 layout in `home`. Files contain identifiable strings so
// we can verify content survives the migration intact.
function buildV1Home(home) {
  // db/
  mkdirSync(join(home, 'db'), { recursive: true });
  writeFileSync(join(home, 'db', 'CURRENT'), 'rocksdb-CURRENT-marker');
  writeFileSync(join(home, 'db', 'LOCK'), '');

  // cache/logs/
  mkdirSync(join(home, 'cache', 'logs'), { recursive: true });
  writeFileSync(join(home, 'cache', 'logs', 'biographer.log'), 'biographer-log-content');
  writeFileSync(join(home, 'cache', 'logs', 'daemon.log'), 'daemon-log-content');
  writeFileSync(join(home, 'cache', 'logs', 'surreal.log'), 'surreal-log-content');

  // cache/v1-import-report-*.json
  writeFileSync(join(home, 'cache', 'v1-import-report-AAA.json'), '{"session":"AAA"}');
  writeFileSync(join(home, 'cache', 'v1-import-report-BBB.json'), '{"session":"BBB"}');

  // cache/sqlite-snapshots/
  mkdirSync(join(home, 'cache', 'sqlite-snapshots'), { recursive: true });
  writeFileSync(join(home, 'cache', 'sqlite-snapshots', 'chrome.db'), 'chrome-snapshot');

  // runtime/state/
  mkdirSync(join(home, 'runtime', 'state', 'published'), { recursive: true });
  writeFileSync(join(home, 'runtime', 'state', 'published', 'index.jsonl'), '{"id":"pub-1"}\n');
  mkdirSync(join(home, 'runtime', 'state', 'telemetry'), { recursive: true });
  writeFileSync(join(home, 'runtime', 'state', 'telemetry', 'publish.log'), 'publish-telemetry');
  writeFileSync(join(home, 'runtime', 'state', 'daemon-status.json'), '{"pid":1234}');
  writeFileSync(join(home, 'runtime', 'state', 'recall-reinforce-last-run.json'), '{"last":"now"}');

  // backup/ — a stray DB snapshot tarball from a prior `robin migrate` run.
  mkdirSync(join(home, 'backup'), { recursive: true });
  writeFileSync(join(home, 'backup', '20260512-214549.tar'), 'snapshot-tar-bytes');

  // secrets/.env
  mkdirSync(join(home, 'secrets'), { recursive: true });
  writeFileSync(join(home, 'secrets', '.env'), 'FOO=bar', { mode: 0o600 });

  // Root JSONs + dotfiles.
  writeFileSync(join(home, 'config.json'), '{"embedder_profile":"x"}');
  writeFileSync(join(home, 'manifest.json'), '{"package_version":"6.0.0"}');
  writeFileSync(join(home, 'host-integrations.json'), '{"version":1,"entries":[]}');
  writeFileSync(join(home, '.manifest.lock'), '');
  // Note: no .daemon.* — those are present only when daemon is running.

  // Marker.
  writeFileSync(
    join(home, '.robin-data'),
    JSON.stringify({ version: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
  );

  // skills/external/ + a couple of skill dirs.
  mkdirSync(join(home, 'skills', 'external', 'pdf'), { recursive: true });
  writeFileSync(join(home, 'skills', 'external', 'pdf', 'SKILL.md'), 'pdf-skill');
  mkdirSync(join(home, 'skills', 'external', 'docx'), { recursive: true });
  writeFileSync(join(home, 'skills', 'external', 'docx', 'SKILL.md'), 'docx-skill');
  writeFileSync(join(home, 'skills', 'external', 'INDEX.md'), 'skills-index');

  // sources/ — text inputs (kept at root in v2 too); plus an empty media/ that should be removed.
  mkdirSync(join(home, 'sources', 'documents'), { recursive: true });
  writeFileSync(join(home, 'sources', 'documents', 'tax.pdf'), 'tax-bytes');
  mkdirSync(join(home, 'sources', 'media'), { recursive: true });

  // upload/ — binary drops (kept at root in v2 too).
  mkdirSync(join(home, 'upload', 'Photos-1'), { recursive: true });
  writeFileSync(join(home, 'upload', 'Photos-1', 'pic.heic'), 'heic-bytes');

  // artifacts/
  mkdirSync(join(home, 'artifacts'), { recursive: true });
  writeFileSync(join(home, 'artifacts', 'note.md'), 'note-content');

  // jobs/
  mkdirSync(join(home, 'jobs'), { recursive: true });
  writeFileSync(join(home, 'jobs', 'daily-briefing.md'), 'daily-briefing-override');
}

test('detectLayoutVersion: fresh home', () => {
  const home = freshHome('detect-fresh');
  try {
    assert.equal(detectLayoutVersion(home), 'fresh');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('detectLayoutVersion: v1 home (.robin-data at root)', () => {
  const home = freshHome('detect-v1');
  try {
    writeFileSync(join(home, '.robin-data'), JSON.stringify({ version: 1 }));
    assert.equal(detectLayoutVersion(home), 'v1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('detectLayoutVersion: v2 home', () => {
  const home = freshHome('detect-v2');
  try {
    mkdirSync(join(home, 'runtime', 'install'), { recursive: true });
    writeFileSync(
      join(home, 'runtime', 'install', '.marker.json'),
      JSON.stringify({ user_data_layout_version: 2 }),
    );
    assert.equal(detectLayoutVersion(home), 'v2');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('detectLayoutVersion: new-marker-present-but-says-v1 reports v1', () => {
  const home = freshHome('detect-newbutv1');
  try {
    mkdirSync(join(home, 'runtime', 'install'), { recursive: true });
    writeFileSync(
      join(home, 'runtime', 'install', '.marker.json'),
      JSON.stringify({ user_data_layout_version: 1 }),
    );
    assert.equal(detectLayoutVersion(home), 'v1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrateUserDataLayout: full v1 home → v2 layout', async () => {
  const home = freshHome('migrate-full');
  try {
    buildV1Home(home);

    const result = await migrateUserDataLayout(home);
    assert.deepEqual(result, { migrated: true, dryRun: false });

    // Marker is v2 and preserves createdAt.
    const markerPath = join(home, 'runtime', 'install', '.marker.json');
    assert.ok(existsSync(markerPath), 'new marker present');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(marker.user_data_layout_version, 2);
    assert.equal(marker.createdAt, '2026-01-01T00:00:00.000Z', 'createdAt preserved from legacy');
    assert.ok(typeof marker.migrated_at === 'string', 'migrated_at stamped');
    assert.equal(existsSync(join(home, '.robin-data')), false, 'legacy marker removed');

    // db/ → data/db/
    assert.equal(existsSync(join(home, 'data', 'db', 'CURRENT')), true);
    assert.equal(
      readFileSync(join(home, 'data', 'db', 'CURRENT'), 'utf8'),
      'rocksdb-CURRENT-marker',
    );
    assert.equal(existsSync(join(home, 'db')), false, 'old db/ removed');

    // cache/logs/ → runtime/logs/
    assert.equal(
      readFileSync(join(home, 'runtime', 'logs', 'biographer.log'), 'utf8'),
      'biographer-log-content',
    );
    assert.equal(
      readFileSync(join(home, 'runtime', 'logs', 'daemon.log'), 'utf8'),
      'daemon-log-content',
    );
    assert.equal(
      readFileSync(join(home, 'runtime', 'logs', 'surreal.log'), 'utf8'),
      'surreal-log-content',
    );

    // cache/v1-import-report-* → runtime/install/reports/
    assert.equal(
      readFileSync(
        join(home, 'runtime', 'install', 'reports', 'v1-import-report-AAA.json'),
        'utf8',
      ),
      '{"session":"AAA"}',
    );
    assert.equal(
      readFileSync(
        join(home, 'runtime', 'install', 'reports', 'v1-import-report-BBB.json'),
        'utf8',
      ),
      '{"session":"BBB"}',
    );

    // cache/sqlite-snapshots/ → io/sqlite-snapshots/
    assert.equal(
      readFileSync(join(home, 'io', 'sqlite-snapshots', 'chrome.db'), 'utf8'),
      'chrome-snapshot',
    );

    // runtime/state/* redistributed
    assert.equal(
      readFileSync(join(home, 'io', 'publish', 'index.jsonl'), 'utf8'),
      '{"id":"pub-1"}\n',
    );
    assert.equal(
      readFileSync(join(home, 'runtime', 'logs', 'publish.log'), 'utf8'),
      'publish-telemetry',
    );
    assert.equal(
      readFileSync(join(home, 'runtime', 'daemon', 'status.json'), 'utf8'),
      '{"pid":1234}',
    );
    assert.equal(
      readFileSync(join(home, 'cognition', 'reinforcement-last-run.json'), 'utf8'),
      '{"last":"now"}',
    );

    // Root JSONs + dotfiles
    assert.equal(
      readFileSync(join(home, 'config', 'config.json'), 'utf8'),
      '{"embedder_profile":"x"}',
    );
    assert.equal(
      readFileSync(join(home, 'runtime', 'install', 'manifest.json'), 'utf8'),
      '{"package_version":"6.0.0"}',
    );
    assert.equal(
      readFileSync(join(home, 'runtime', 'install', 'host-integrations.json'), 'utf8'),
      '{"version":1,"entries":[]}',
    );

    // secrets/ → config/secrets/
    assert.equal(readFileSync(join(home, 'config', 'secrets', '.env'), 'utf8'), 'FOO=bar');
    assert.equal(existsSync(join(home, 'secrets')), false, 'old secrets/ removed');

    // skills/external/* → skills/*
    assert.equal(readFileSync(join(home, 'skills', 'INDEX.md'), 'utf8'), 'skills-index');
    assert.equal(readFileSync(join(home, 'skills', 'pdf', 'SKILL.md'), 'utf8'), 'pdf-skill');
    assert.equal(readFileSync(join(home, 'skills', 'docx', 'SKILL.md'), 'utf8'), 'docx-skill');
    assert.equal(
      existsSync(join(home, 'skills', 'external')),
      false,
      'old skills/external/ removed',
    );

    // sources/media/ removed; sources/documents/ preserved
    assert.equal(existsSync(join(home, 'sources', 'media')), false, 'empty media/ removed');
    assert.equal(readFileSync(join(home, 'sources', 'documents', 'tax.pdf'), 'utf8'), 'tax-bytes');

    // upload/, artifacts/, jobs/ preserved at root
    assert.equal(readFileSync(join(home, 'upload', 'Photos-1', 'pic.heic'), 'utf8'), 'heic-bytes');
    assert.equal(readFileSync(join(home, 'artifacts', 'note.md'), 'utf8'), 'note-content');
    assert.equal(
      readFileSync(join(home, 'jobs', 'daily-briefing.md'), 'utf8'),
      'daily-briefing-override',
    );

    // backup/*.tar → data/snapshots/
    assert.equal(
      readFileSync(join(home, 'data', 'snapshots', '20260512-214549.tar'), 'utf8'),
      'snapshot-tar-bytes',
      'backup tarball moved into data/snapshots/',
    );

    // Cleanup happened
    assert.equal(existsSync(join(home, 'cache')), false, 'cache/ removed');
    assert.equal(existsSync(join(home, 'backup')), false, 'backup/ removed');
    assert.equal(existsSync(join(home, 'runtime', 'state')), false, 'runtime/state/ removed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrateUserDataLayout: idempotent on v2 home (second call is no-op)', async () => {
  const home = freshHome('migrate-idem');
  try {
    buildV1Home(home);
    await migrateUserDataLayout(home);
    const result = await migrateUserDataLayout(home);
    assert.deepEqual(result, { migrated: false, reason: 'v2' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrateUserDataLayout: fresh home returns no-op', async () => {
  const home = freshHome('migrate-fresh');
  try {
    const result = await migrateUserDataLayout(home);
    assert.deepEqual(result, { migrated: false, reason: 'fresh' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrateUserDataLayout: dry-run does not write', async () => {
  const home = freshHome('migrate-dry');
  try {
    buildV1Home(home);
    const lines = [];
    const result = await migrateUserDataLayout(home, {
      dryRun: true,
      log: (m) => lines.push(m),
    });
    assert.equal(result.migrated, true);
    assert.equal(result.dryRun, true);
    // Nothing on disk should have moved.
    assert.equal(existsSync(join(home, 'db', 'CURRENT')), true);
    assert.equal(existsSync(join(home, '.robin-data')), true);
    assert.equal(existsSync(join(home, 'data', 'db')), false);
    assert.ok(lines.length > 0, 'log captured at least one planned step');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrateUserDataLayout: refuses while a daemon (alive pid) is registered', async () => {
  const home = freshHome('migrate-daemon');
  try {
    buildV1Home(home);
    // process.pid is, by definition, alive.
    writeFileSync(join(home, '.daemon.pid'), String(process.pid));
    await assert.rejects(
      () => migrateUserDataLayout(home),
      (err) => err.code === 'LAYOUT_MIGRATOR_DAEMON_RUNNING',
    );
    // Migration must not have happened.
    assert.equal(existsSync(join(home, 'db', 'CURRENT')), true, 'db/ still in place');
    assert.equal(existsSync(join(home, 'data', 'db')), false, 'data/db/ not created');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrateUserDataLayout: stale lockfile (dead pid) is stolen', async () => {
  const home = freshHome('migrate-stalelock');
  try {
    buildV1Home(home);
    // PID 999999 is unlikely to exist. If it happens to, the test will skip
    // by detecting "alive" and aborting; in practice CI nodes don't reach that
    // pid count.
    writeFileSync(join(home, '.layout-migrator.lock'), '999999');
    const result = await migrateUserDataLayout(home);
    assert.equal(result.migrated, true, 'migration completed after stealing stale lock');
    assert.equal(existsSync(join(home, '.layout-migrator.lock')), false, 'lock removed after run');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrateUserDataLayout: aborts when source and destination are BOTH non-empty', async () => {
  const home = freshHome('migrate-conflict');
  try {
    buildV1Home(home);
    // Pre-create data/db/ with content. The migrator's moveEntry guard should
    // refuse rather than overwrite.
    mkdirSync(join(home, 'data', 'db'), { recursive: true });
    writeFileSync(join(home, 'data', 'db', 'stranger'), 'do-not-overwrite');
    await assert.rejects(
      () => migrateUserDataLayout(home),
      (err) => err.code === 'LAYOUT_MIGRATOR_CONFLICT',
    );
    // Stranger content is preserved.
    assert.equal(readFileSync(join(home, 'data', 'db', 'stranger'), 'utf8'), 'do-not-overwrite');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrateUserDataLayout: partial run resumes (empty destination dir gets replaced)', async () => {
  const home = freshHome('migrate-partial');
  try {
    buildV1Home(home);
    // Simulate a prior crashed run that pre-created an empty target dir.
    mkdirSync(join(home, 'data', 'db'), { recursive: true });
    // The directory is empty — moveEntry should rmdir it and proceed.
    const result = await migrateUserDataLayout(home);
    assert.equal(result.migrated, true);
    assert.equal(
      readFileSync(join(home, 'data', 'db', 'CURRENT'), 'utf8'),
      'rocksdb-CURRENT-marker',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
