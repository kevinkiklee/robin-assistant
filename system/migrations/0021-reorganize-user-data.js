// Migration 0021: reorganize user-data layout. See
// docs/superpowers/specs/2026-05-01-user-data-reorg-design.md
//
// Idempotent: re-running after partial application completes safely.
// Reversible via down().

import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, cpSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createHelpers } from '../scripts/migrate/lib/migration-helpers.js';

export const id = '0021-reorganize-user-data';
export const description = 'Reorganize user-data into memory/, sources/, and ops/.';

// macOS resolves /var/folders → /private/var/folders, so a literal startsWith
// check against tmpdir() misses subprocess cwd paths that come back resolved
// (e.g. npm install postinstall under a tempdir). Compare via realpath.
function isUnderTmpdir(workspaceDir) {
  if (!workspaceDir) return false;
  try {
    const tmpReal = realpathSync(tmpdir());
    const wdReal = existsSync(workspaceDir) ? realpathSync(workspaceDir) : workspaceDir;
    return wdReal.startsWith(tmpReal) || workspaceDir.startsWith(tmpdir());
  } catch {
    return workspaceDir.startsWith(tmpdir());
  }
}

function stopDaemons(workspaceDir) {
  if (process.platform !== 'darwin') return;
  // Skip when running against a test workspace (tmpdir). Touching the real
  // user launchd domain from a tempdir-scoped install (e.g. e2e install
  // scenario tests) tears down the user's running discord bot.
  if (isUnderTmpdir(workspaceDir)) return;
  for (const label of ['com.robin.discord-bot-watchdog', 'com.robin.discord-bot']) {
    try {
      execSync(`launchctl unload ~/Library/LaunchAgents/${label}.plist 2>/dev/null`, {
        stdio: 'ignore',
      });
      console.log(`[${id}] stopped ${label}`);
    } catch {
      // plist absent or already unloaded — fine
    }
  }
}

export async function up({ workspaceDir, force = false }) {
  // Pre-flight: refuse if another session is active < 2h.
  if (!force) {
    const sessPath = join(workspaceDir, 'user-data/state/sessions.md');
    if (existsSync(sessPath)) {
      const content = readFileSync(sessPath, 'utf8');
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      const isoMatches = content.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g) || [];
      const hasActive = isoMatches.some((iso) => new Date(iso).getTime() > twoHoursAgo);
      if (hasActive) {
        throw new Error(
          `[${id}] Another Robin session is active (sessions.md has rows < 2h old). ` +
          `Close it before running this migration, or pass { force: true } to override.`,
        );
      }
    }
  }

  // Snapshot user-data/ to backup/user-data-<timestamp>/ before any moves.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = join(workspaceDir, 'backup', `user-data-${ts}`);
  mkdirSync(dirname(snapshotDir), { recursive: true });
  cpSync(join(workspaceDir, 'user-data'), snapshotDir, { recursive: true });
  console.log(`[${id}] snapshot saved to ${snapshotDir}`);

  stopDaemons(workspaceDir);

  const helpers = createHelpers(workspaceDir);

  // Step 1: top-level moves. Order matters — state/ first so .migrations-applied
  // can land inside ops/state/.
  await helpers.renameFile('state', 'ops/state');
  await helpers.renameFile('.migrations-applied.json', 'ops/state/migrations-applied.json');
  await helpers.renameFile('manifest.md', 'memory/MANIFEST.md');
  await helpers.renameFile('integrations.md', 'ops/config/integrations.md');
  await helpers.renameFile('policies.md', 'ops/config/policies.md');
  await helpers.renameFile('robin.config.json', 'ops/config/robin.config.json');
  await helpers.renameFile('jobs', 'ops/jobs');
  await helpers.renameFile('scripts', 'ops/scripts');
  await helpers.renameFile('secrets', 'ops/secrets');
  await helpers.renameFile('security', 'ops/security');
  // sources/ stays at user-data/ root; memory/ stays at user-data/ root.

  // Force case change for MANIFEST.md (macOS case-insensitive FS workaround).
  // renameFile may have moved manifest.md → MANIFEST.md but kept the lowercase name.
  const manifestPath = join(workspaceDir, 'user-data/memory/MANIFEST.md');
  const manifestTmp = join(workspaceDir, 'user-data/memory/__MANIFEST_TMP.md');
  if (existsSync(manifestPath)) {
    renameSync(manifestPath, manifestTmp);
    renameSync(manifestTmp, manifestPath);
  }

  // Step 2: ops/state/ internal restructuring
  const opsState = (rel) => join(workspaceDir, 'user-data/ops/state', rel);

  for (const sub of ['telemetry', 'services', 'turn', 'cache']) {
    mkdirSync(opsState(sub), { recursive: true });
  }

  const moveInState = (file, subdir) => {
    const src = opsState(file);
    if (!existsSync(src)) return;
    renameSync(src, opsState(`${subdir}/${file}`));
  };

  for (const f of ['high-stakes-writes.log', 'policy-refusals.log',
                   'capture-enforcement.log', 'capture-enforcement-debug.log',
                   'turn-writes.log']) {
    moveInState(f, 'telemetry');
  }
  for (const f of ['discord-bot.status.json', 'discord-sessions.json',
                   'discord-bot.events.jsonl', 'discord-bot-health.md']) {
    moveInState(f, 'services');
  }
  // Drain old state/logs/ into services/
  const oldLogsDir = opsState('logs');
  if (existsSync(oldLogsDir)) {
    for (const entry of readdirSync(oldLogsDir)) {
      renameSync(join(oldLogsDir, entry), opsState(`services/${entry}`));
    }
    rmSync(oldLogsDir, { recursive: true });
  }
  for (const f of ['turn.json', 'capture-retry.json', 'pending-asks.md']) {
    moveInState(f, 'turn');
  }
  for (const f of ['entities-hash.txt', 'untrusted-index.json',
                   'github-allowlist-cache.json']) {
    moveInState(f, 'cache');
  }

  // Drop dot-prefixes in ops/state/jobs/
  for (const dotted of ['.notification-state.json', '.sync-hash', '.workspace-path']) {
    const src = opsState(`jobs/${dotted}`);
    if (!existsSync(src)) continue;
    renameSync(src, opsState(`jobs/${dotted.slice(1)}`));
  }

  // Delete empty ops/state/locks/
  const oldLocksDir = opsState('locks');
  if (existsSync(oldLocksDir) && readdirSync(oldLocksDir).length === 0) {
    rmSync(oldLocksDir, { recursive: true });
  }

  // Step 3: memory/ internal restructuring
  const memDir = (rel) => join(workspaceDir, 'user-data/memory', rel);

  mkdirSync(memDir('streams'), { recursive: true });
  for (const f of ['inbox.md', 'journal.md', 'log.md', 'decisions.md']) {
    const src = memDir(f);
    if (existsSync(src)) renameSync(src, memDir(`streams/${f}`));
  }

  // Stale backup cleanup
  const staleBackup = memDir('self-improvement.md.pre-0008');
  if (existsSync(staleBackup)) rmSync(staleBackup);

  // service-providers shadowing: prefer the directory; remove the .md if it's a stub
  const serviceProvidersFile = memDir('knowledge/service-providers.md');
  const serviceProvidersDir = memDir('knowledge/service-providers');
  if (existsSync(serviceProvidersFile) && existsSync(serviceProvidersDir)) {
    // Append .md content into directory's INDEX.md (creating if needed)
    const indexPath = join(serviceProvidersDir, 'INDEX.md');
    const indexContent = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '# Service Providers\n';
    const stubContent = readFileSync(serviceProvidersFile, 'utf8');
    writeFileSync(indexPath, indexContent + '\n<!-- merged from shadow .md -->\n' + stubContent);
    rmSync(serviceProvidersFile);
  }
}

export async function down({ workspaceDir }) {
  const helpers = createHelpers(workspaceDir);
  const ud = (rel) => join(workspaceDir, 'user-data', rel);

  // Reverse memory restructuring
  for (const f of ['inbox.md', 'journal.md', 'log.md', 'decisions.md']) {
    const src = ud(`memory/streams/${f}`);
    if (existsSync(src)) renameSync(src, ud(`memory/${f}`));
  }
  if (existsSync(ud('memory/streams')) && readdirSync(ud('memory/streams')).length === 0) {
    rmSync(ud('memory/streams'), { recursive: true });
  }

  // Reverse state restructuring
  const flattenStateSub = (sub) => {
    const dir = ud(`ops/state/${sub}`);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      renameSync(join(dir, entry), ud(`ops/state/${entry}`));
    }
    rmSync(dir, { recursive: true });
  };
  for (const sub of ['telemetry', 'services', 'turn', 'cache']) flattenStateSub(sub);

  // Restore dot-prefixes
  for (const dotted of ['notification-state.json', 'sync-hash', 'workspace-path']) {
    const src = ud(`ops/state/jobs/${dotted}`);
    if (existsSync(src)) renameSync(src, ud(`ops/state/jobs/.${dotted}`));
  }

  // Reverse top-level moves
  await helpers.renameFile('ops/state/migrations-applied.json', '.migrations-applied.json');
  await helpers.renameFile('ops/state', 'state');

  // Restore state/logs/ — daemon logs were drained into services/ by up(),
  // and flattenStateSub('services') just moved them to state/ root. Re-nest.
  const stateLogsDir = ud('state/logs');
  mkdirSync(stateLogsDir, { recursive: true });
  for (const f of ['discord-bot.log', 'discord-bot-watchdog.log', 'discord-bot.events.jsonl']) {
    const src = ud(`state/${f}`);
    if (existsSync(src)) renameSync(src, join(stateLogsDir, f));
  }

  // Recreate empty state/locks/ — up() removed it for being empty
  mkdirSync(ud('state/locks'), { recursive: true });

  await helpers.renameFile('ops/config/integrations.md', 'integrations.md');
  await helpers.renameFile('ops/config/policies.md', 'policies.md');
  await helpers.renameFile('ops/config/robin.config.json', 'robin.config.json');
  await helpers.renameFile('memory/MANIFEST.md', 'manifest.md');

  // Reverse service-providers shadow merge
  const spDirIndex = ud('memory/knowledge/service-providers/INDEX.md');
  if (existsSync(spDirIndex)) {
    const idxContent = readFileSync(spDirIndex, 'utf8');
    const marker = '\n<!-- merged from shadow .md -->\n';
    const idx = idxContent.indexOf(marker);
    if (idx >= 0) {
      const beforeMarker = idxContent.slice(0, idx);
      const afterMarker = idxContent.slice(idx + marker.length);
      // Write the stub back as service-providers.md
      writeFileSync(ud('memory/knowledge/service-providers.md'), afterMarker);
      // Restore INDEX.md without the marker (or remove it if it was created just for this)
      const trimmed = beforeMarker.trim();
      if (trimmed === '# Service Providers' || trimmed === '') {
        // INDEX.md was created by up() — remove it
        rmSync(spDirIndex);
      } else {
        writeFileSync(spDirIndex, beforeMarker);
      }
    }
  }

  await helpers.renameFile('ops/jobs', 'jobs');
  await helpers.renameFile('ops/scripts', 'scripts');
  await helpers.renameFile('ops/secrets', 'secrets');
  await helpers.renameFile('ops/security', 'security');

  // Clean up empty ops/
  if (existsSync(ud('ops/config')) && readdirSync(ud('ops/config')).length === 0) {
    rmSync(ud('ops/config'), { recursive: true });
  }
  if (existsSync(ud('ops')) && readdirSync(ud('ops')).length === 0) {
    rmSync(ud('ops'), { recursive: true });
  }
}
