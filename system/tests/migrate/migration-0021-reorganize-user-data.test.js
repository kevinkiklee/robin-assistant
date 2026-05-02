import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as migration from '../../migrations/0021-reorganize-user-data.js';
import { createHelpers } from '../../scripts/migrate/lib/migration-helpers.js';

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'robin-mig-0021-'));
  const ud = join(root, 'user-data');

  // Top-level files
  mkdirSync(ud, { recursive: true });
  writeFileSync(join(ud, 'manifest.md'), '# Memory Manifest\n');
  writeFileSync(join(ud, 'integrations.md'), '# Integrations\n');
  writeFileSync(join(ud, 'policies.md'), '# Policies\n');
  writeFileSync(join(ud, 'robin.config.json'), JSON.stringify({ version: '3.0.0' }) + '\n');
  writeFileSync(join(ud, '.migrations-applied.json'), JSON.stringify({ applied: [] }));

  // Top-level dirs
  for (const d of ['jobs', 'scripts', 'secrets', 'security', 'sources/notes']) {
    mkdirSync(join(ud, d), { recursive: true });
  }
  writeFileSync(join(ud, 'jobs/morning-briefing.md'), '# Morning Briefing\n');
  writeFileSync(join(ud, 'scripts/sync-gmail.js'), '// sync gmail\n');
  writeFileSync(join(ud, 'secrets/.env'), 'GITHUB_PAT=fake\n');
  writeFileSync(join(ud, 'secrets/.gitignore'), '*\n!.gitignore\n!README.md\n');
  writeFileSync(join(ud, 'secrets/README.md'), '# Secrets\n');
  writeFileSync(join(ud, 'security/manifest.json'), JSON.stringify({ version: 1 }));
  writeFileSync(join(ud, 'sources/notes/example.md'), '# Notes\n');

  // memory/ root files (loose) + subdirs
  mkdirSync(join(ud, 'memory/profile'), { recursive: true });
  mkdirSync(join(ud, 'memory/knowledge/service-providers'), { recursive: true });
  mkdirSync(join(ud, 'memory/self-improvement'), { recursive: true });
  mkdirSync(join(ud, 'memory/watches'), { recursive: true });
  mkdirSync(join(ud, 'memory/archive'), { recursive: true });
  mkdirSync(join(ud, 'memory/quarantine'), { recursive: true });
  for (const f of ['INDEX.md', 'ENTITIES.md', 'LINKS.md', 'hot.md',
                   'inbox.md', 'journal.md', 'log.md', 'decisions.md', 'tasks.md']) {
    writeFileSync(join(ud, 'memory', f), `# ${f}\n`);
  }
  writeFileSync(join(ud, 'memory/self-improvement.md.pre-0008'), '# stale\n');
  writeFileSync(join(ud, 'memory/knowledge/service-providers.md'), '# stub\n');
  writeFileSync(join(ud, 'memory/knowledge/service-providers/abco.md'), '# Abco\n');
  writeFileSync(join(ud, 'memory/profile/identity.md'), '# Identity\n');

  // state/ — files + subdirs (mirrors live layout)
  mkdirSync(join(ud, 'state/jobs/locks'), { recursive: true });
  mkdirSync(join(ud, 'state/jobs/logs'), { recursive: true });
  mkdirSync(join(ud, 'state/sync'), { recursive: true });
  mkdirSync(join(ud, 'state/watches'), { recursive: true });
  mkdirSync(join(ud, 'state/locks'), { recursive: true });  // empty — to be deleted
  mkdirSync(join(ud, 'state/logs'), { recursive: true });   // daemon logs — to be services/

  writeFileSync(join(ud, 'state/sessions.md'), '# Sessions\n');
  writeFileSync(join(ud, 'state/dream-state.md'), 'last_dream_at: 2026-04-30T20:50:00Z\n');
  writeFileSync(join(ud, 'state/turn.json'), '{}');
  writeFileSync(join(ud, 'state/capture-retry.json'), '{}');
  writeFileSync(join(ud, 'state/pending-asks.md'), '# Pending\n');
  writeFileSync(join(ud, 'state/high-stakes-writes.log'), '');
  writeFileSync(join(ud, 'state/policy-refusals.log'), '');
  writeFileSync(join(ud, 'state/capture-enforcement.log'), '');
  writeFileSync(join(ud, 'state/turn-writes.log'), '');
  writeFileSync(join(ud, 'state/discord-bot.status.json'), '{}');
  writeFileSync(join(ud, 'state/discord-sessions.json'), '{}');
  writeFileSync(join(ud, 'state/entities-hash.txt'), 'abc123');
  writeFileSync(join(ud, 'state/logs/discord-bot.log'), '');
  writeFileSync(join(ud, 'state/jobs/.notification-state.json'), '{}');
  writeFileSync(join(ud, 'state/jobs/.sync-hash'), 'hash');
  writeFileSync(join(ud, 'state/jobs/.workspace-path'), '/tmp/x');
  writeFileSync(join(ud, 'state/jobs/INDEX.md'), '# Jobs\n');
  writeFileSync(join(ud, 'state/jobs/failures.md'), '# Failures\n');

  return { root, ud };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test('migration scaffold exposes id and description', () => {
  assert.equal(migration.id, '0021-reorganize-user-data');
  assert.match(migration.description, /Reorganize user-data/i);
  assert.equal(typeof migration.up, 'function');
  assert.equal(typeof migration.down, 'function');
});

test('top-level moves: config files into ops/config/', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'ops/config/integrations.md')), 'integrations.md moved');
    assert.ok(existsSync(join(ud, 'ops/config/policies.md')), 'policies.md moved');
    assert.ok(existsSync(join(ud, 'ops/config/robin.config.json')), 'robin.config.json moved');
    assert.ok(!existsSync(join(ud, 'integrations.md')), 'old integrations.md removed');
    assert.ok(!existsSync(join(ud, 'policies.md')), 'old policies.md removed');
    assert.ok(!existsSync(join(ud, 'robin.config.json')), 'old robin.config.json removed');
  } finally { cleanup(root); }
});

test('top-level moves: jobs/, scripts/, secrets/, security/ into ops/', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    for (const d of ['jobs', 'scripts', 'secrets', 'security']) {
      assert.ok(existsSync(join(ud, 'ops', d)), `ops/${d}/ exists`);
      assert.ok(!existsSync(join(ud, d)), `old ${d}/ removed`);
    }
    assert.ok(existsSync(join(ud, 'ops/secrets/.env')), '.env preserved');
    assert.ok(existsSync(join(ud, 'ops/scripts/sync-gmail.js')), 'script preserved');
    assert.ok(existsSync(join(ud, 'ops/jobs/morning-briefing.md')), 'job preserved');
  } finally { cleanup(root); }
});

test('top-level moves: sources/ stays at user-data/ root', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'sources/notes/example.md')), 'sources kept at root');
    assert.ok(!existsSync(join(ud, 'ops/sources')), 'sources NOT under ops/');
  } finally { cleanup(root); }
});

test('.migrations-applied.json moves to ops/state/migrations-applied.json (no leading dot)', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'ops/state/migrations-applied.json')));
    assert.ok(!existsSync(join(ud, '.migrations-applied.json')));
  } finally { cleanup(root); }
});

test('manifest.md moves to memory/MANIFEST.md (uppercase rename)', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'memory/MANIFEST.md')), 'MANIFEST.md exists');
    assert.ok(!existsSync(join(ud, 'manifest.md')), 'old manifest.md removed');
  } finally { cleanup(root); }
});

test('manifest.md → MANIFEST.md actually changes case on disk', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    const memoryEntries = readdirSync(join(ud, 'memory'));
    assert.ok(memoryEntries.includes('MANIFEST.md'), `MANIFEST.md (uppercase) in ${memoryEntries.join(',')}`);
    assert.ok(!memoryEntries.includes('manifest.md'), 'lowercase manifest.md absent');
  } finally { cleanup(root); }
});

test('ops/state/ — telemetry/ groups protection logs', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    for (const f of ['high-stakes-writes.log', 'policy-refusals.log',
                     'capture-enforcement.log', 'turn-writes.log']) {
      assert.ok(existsSync(join(ud, 'ops/state/telemetry', f)), `telemetry/${f}`);
      assert.ok(!existsSync(join(ud, 'ops/state', f)), `${f} not at state root`);
    }
  } finally { cleanup(root); }
});

test('ops/state/ — services/ groups daemon state', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    for (const f of ['discord-bot.status.json', 'discord-sessions.json']) {
      assert.ok(existsSync(join(ud, 'ops/state/services', f)));
    }
    assert.ok(existsSync(join(ud, 'ops/state/services/discord-bot.log')), 'logs/ contents moved');
    assert.ok(!existsSync(join(ud, 'ops/state/logs')), 'old logs/ dir removed');
  } finally { cleanup(root); }
});

test('ops/state/ — turn/ groups turn-loop state', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    for (const f of ['turn.json', 'capture-retry.json', 'pending-asks.md']) {
      assert.ok(existsSync(join(ud, 'ops/state/turn', f)));
    }
  } finally { cleanup(root); }
});

test('ops/state/ — cache/ groups recomputable state', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'ops/state/cache/entities-hash.txt')));
  } finally { cleanup(root); }
});

test('ops/state/ — sessions.md and dream-state.md remain at root', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'ops/state/sessions.md')));
    assert.ok(existsSync(join(ud, 'ops/state/dream-state.md')));
  } finally { cleanup(root); }
});

test('ops/state/jobs/ — drop dot-prefixes', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'ops/state/jobs/notification-state.json')));
    assert.ok(existsSync(join(ud, 'ops/state/jobs/sync-hash')));
    assert.ok(existsSync(join(ud, 'ops/state/jobs/workspace-path')));
    assert.ok(!existsSync(join(ud, 'ops/state/jobs/.notification-state.json')));
  } finally { cleanup(root); }
});

test('ops/state/ — empty locks/ is removed', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    assert.ok(!existsSync(join(ud, 'ops/state/locks')), 'empty locks/ removed');
  } finally { cleanup(root); }
});

test('memory/streams/ groups append-only files', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    for (const f of ['inbox.md', 'journal.md', 'log.md', 'decisions.md']) {
      assert.ok(existsSync(join(ud, 'memory/streams', f)), `streams/${f}`);
      assert.ok(!existsSync(join(ud, 'memory', f)), `${f} removed from root`);
    }
  } finally { cleanup(root); }
});

test('memory/ — INDEX, ENTITIES, LINKS, hot, tasks stay at root', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    for (const f of ['INDEX.md', 'ENTITIES.md', 'LINKS.md', 'hot.md', 'tasks.md']) {
      assert.ok(existsSync(join(ud, 'memory', f)), `${f} at root`);
    }
  } finally { cleanup(root); }
});

test('memory/self-improvement.md.pre-0008 stale backup deleted', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    assert.ok(!existsSync(join(ud, 'memory/self-improvement.md.pre-0008')));
  } finally { cleanup(root); }
});

test('memory/knowledge/service-providers shadowing resolved', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    assert.ok(!existsSync(join(ud, 'memory/knowledge/service-providers.md')),
      'shadow .md removed');
    assert.ok(existsSync(join(ud, 'memory/knowledge/service-providers/abco.md')),
      'directory contents preserved');
  } finally { cleanup(root); }
});

test('migration is idempotent — running twice produces same result', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    await migration.up({ workspaceDir: root });  // second run must not throw
    assert.ok(existsSync(join(ud, 'ops/config/robin.config.json')));
    assert.ok(existsSync(join(ud, 'ops/state/migrations-applied.json')));
    assert.ok(existsSync(join(ud, 'memory/MANIFEST.md')));
    assert.ok(existsSync(join(ud, 'memory/streams/inbox.md')));
  } finally { cleanup(root); }
});

test('down() reverses up() — restores original layout', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    await migration.down({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'integrations.md')));
    assert.ok(existsSync(join(ud, 'robin.config.json')));
    assert.ok(existsSync(join(ud, '.migrations-applied.json')));
    assert.ok(existsSync(join(ud, 'manifest.md')));
    assert.ok(existsSync(join(ud, 'memory/inbox.md')));
    assert.ok(existsSync(join(ud, 'state/sessions.md')));
    assert.ok(!existsSync(join(ud, 'ops')));
  } finally { cleanup(root); }
});

test('down() restores state/logs/ for daemon logs', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    await migration.down({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'state/logs/discord-bot.log')),
      'discord-bot.log restored to state/logs/');
    assert.ok(!existsSync(join(ud, 'state/discord-bot.log')),
      'discord-bot.log NOT at state/ root');
  } finally { cleanup(root); }
});

test('down() restores empty state/locks/', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    await migration.down({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'state/locks')), 'state/locks/ exists');
    assert.equal(readdirSync(join(ud, 'state/locks')).length, 0, 'state/locks/ empty');
  } finally { cleanup(root); }
});

test('down() restores service-providers.md shadow', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    await migration.down({ workspaceDir: root });
    assert.ok(existsSync(join(ud, 'memory/knowledge/service-providers.md')),
      'shadow .md restored');
    const content = readFileSync(join(ud, 'memory/knowledge/service-providers.md'), 'utf8');
    assert.match(content, /stub/, 'original stub content preserved');
    // INDEX.md should not contain the marker after split
    const indexPath = join(ud, 'memory/knowledge/service-providers/INDEX.md');
    if (existsSync(indexPath)) {
      const idx = readFileSync(indexPath, 'utf8');
      assert.ok(!idx.includes('<!-- merged from shadow .md -->'),
        'marker removed from INDEX.md after down()');
    }
  } finally { cleanup(root); }
});

test('pre-flight: refuses if active session in state/sessions.md', async () => {
  const { root, ud } = setupFixture();
  try {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    writeFileSync(join(ud, 'state/sessions.md'),
      `| platform | started | last-active |\n| -- | -- | -- |\n| claude | x | ${recent} |\n`);
    await assert.rejects(
      () => migration.up({ workspaceDir: root }),
      /active.*session/i,
    );
  } finally { cleanup(root); }
});

test('pre-flight: --force overrides active session check', async () => {
  const { root, ud } = setupFixture();
  try {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(join(ud, 'state/sessions.md'),
      `| platform | started | last-active |\n| -- | -- | -- |\n| claude | x | ${recent} |\n`);
    await migration.up({ workspaceDir: root, force: true });  // does not throw
    assert.ok(existsSync(join(ud, 'ops/config/robin.config.json')));
  } finally { cleanup(root); }
});

test('pre-flight: creates snapshot at backup/user-data-<timestamp>/', async () => {
  const { root, ud } = setupFixture();
  try {
    await migration.up({ workspaceDir: root });
    const backupRoot = join(root, 'backup');
    assert.ok(existsSync(backupRoot), 'backup/ directory created');
    const snapshots = readdirSync(backupRoot).filter((d) => d.startsWith('user-data-'));
    assert.equal(snapshots.length, 1, 'one snapshot');
    assert.ok(existsSync(join(backupRoot, snapshots[0], 'integrations.md')),
      'snapshot contains pre-migration files');
  } finally { cleanup(root); }
});

test('stopDaemons skipped for tmpdir workspaces (test isolation)', async () => {
  // This test verifies that running up() against a tmpdir does NOT touch host daemons.
  // It works by relying on the up() implementation's tmpdir guard. If guard is missing,
  // launchctl errors would surface (in non-darwin we just verify the call completes).
  const { root } = setupFixture();
  try {
    // Should complete without throwing or leaving side effects on host
    await migration.up({ workspaceDir: root });
    // If we got here, no host-side launchctl error was thrown
    assert.ok(true);
  } finally { cleanup(root); }
});
