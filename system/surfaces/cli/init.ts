import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import {
  buildDaemonSpecFromEnv,
  installDaemonLaunchd,
  resolveUserDataDirForLaunchd,
} from '../../lib/launchd/install.ts';
import {
  dbFilePath,
  resolveUserDataDir,
  userDataPaths,
  writeUserDataPointer,
} from '../../lib/paths.ts';

export interface InitOptions {
  yes?: boolean;
  profile?: string;
  noModels?: boolean;
  noLaunchd?: boolean;
}

export async function runInit(opts: InitOptions): Promise<void> {
  if (!opts.yes) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.error(
      'Interactive init not yet implemented. Use `robin init --yes` for non-interactive setup.',
    );
    process.exit(2);
  }

  const userData = resolveUserDataDir();
  const paths = userDataPaths(userData);

  // Create the canonical directory tree
  for (const dir of [
    paths.state.db,
    paths.state.kuzu,
    paths.state.runtime,
    paths.state.migrations,
    paths.config.root,
    paths.config.secrets,
    paths.config.templates,
    paths.extensions.integrations,
    paths.extensions.jobs,
    paths.extensions.triggers,
    paths.extensions.scripts,
    paths.extensions.skills,
    paths.content.artifacts,
    paths.content.sources,
    // Narrative-layer profile prose (character.md, voice.md, topic docs). Seeded empty —
    // personal prose is authored by the live session / hand-edited, never by init.
    join(userData, 'content', 'profile'),
    paths.observability.logs,
    paths.observability.eval,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // Detect hardware and write hardware.yaml
  const { detectHardware } = await import('../../lib/hardware/detect.ts');
  const { writeHardwareYaml } = await import('../../lib/hardware/apply.ts');
  const hw = detectHardware();
  writeHardwareYaml(userData, hw);

  // Default policies.yaml if not present
  const policiesPath = join(paths.config.root, 'policies.yaml');
  if (!existsSync(policiesPath)) {
    writeFileSync(
      policiesPath,
      `# Robin policies — power / capture / network state
power:
  state: active
capture:
  enabled: true
network:
  mode: online
`,
    );
  }

  // Default models.yaml — minimal cloud-only placeholder for MVP
  const modelsPath = join(paths.config.root, 'models.yaml');
  if (!existsSync(modelsPath)) {
    writeFileSync(
      modelsPath,
      `# Robin model adapter routing — role -> provider mapping.
# See docs/specs/2026-05-18-robin-v3-design.md §6 for the role taxonomy.
#
# Example (uncomment to enable local embeddings via Ollama):
#
# roles:
#   embed:
#     provider: ollama
#     model: qwen3-embedding:8b
#
# Robin's events_vec is float[4096] to match qwen3-embedding:8b native output.
# If you pick a different embedder, run \`robin upgrade\` after editing the
# events_vec schema; vectors from different models are NOT comparable.
roles: {}
`,
    );
  }

  // Apply schema migrations
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  closeDb(db);

  // Record the instance pointer so future bare CLI invocations (a shell without
  // ROBIN_USER_DATA_DIR set) resolve to this instance instead of the empty XDG
  // stub. Store an absolute path — launchd/CLI both read it verbatim.
  writeUserDataPointer(resolveUserDataDirForLaunchd(userData));

  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`✓ Initialized Robin at ${userData}`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`  Database: ${dbFilePath(userData)}`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`  Config:   ${paths.config.root}`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`  Hardware: ${hw.profile} (${hw.cpu}, ${hw.ram_gb}GB)`);

  // Install + load launchd agent so the daemon autostarts (macOS only).
  // `--no-launchd` opts out; non-macOS platforms silently skip.
  let launchdInstalled = false;
  if (!opts.noLaunchd && platform() === 'darwin') {
    try {
      const spec = buildDaemonSpecFromEnv({ userDataDir: userData });
      const r = installDaemonLaunchd(spec);
      launchdInstalled = true;
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.log(`  Launchd:  ${r.alreadyLoaded ? 'reloaded' : 'loaded'} ${r.plistPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.warn(`  Launchd:  skipped (${msg})`);
    }
  }

  // Install the Claude Code SessionEnd hook so every session is captured automatically.
  // Without this, capture falls back to the 5-min polling claude_code integration (which
  // requires 10-min idle), so sessions land in Robin with up to a 15-min lag.
  // Also install the SessionStart hook so each session opens with the LLM-free primer
  // (corrections, belief heads, profile prose) injected as context.
  try {
    const { installSessionEndHook, installSessionStartHook } = await import(
      '../../lib/claude-hooks/install.ts'
    );
    const end = installSessionEndHook();
    const start = installSessionStartHook();
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(
      `  Hooks:    ${end.replaced ? 'updated' : 'installed'} SessionEnd, ${start.replaced ? 'updated' : 'installed'} SessionStart in ${end.path}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.warn(`  Hooks:    skipped (${msg})`);
  }

  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('');
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('Next steps:');
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('  - robin doctor                 # verify');
  if (launchdInstalled) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log('  - robin status                 # confirm daemon is active+online');
  } else {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log('  - robin daemon install         # install launchd autostart (macOS)');
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log('  - pnpm dev                     # or run foreground daemon manually');
  }
}
