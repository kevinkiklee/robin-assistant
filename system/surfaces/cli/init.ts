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
# Robin's events_vec dimension is fixed by migration (currently float[3072],
# sized for Gemini Embedding 2). Your embed model MUST output that dimension
# (most modern embedders are Matryoshka and can target it). Vectors from
# different models are NOT comparable — switching embedders requires a fresh
# \`robin reindex --force\`.
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

  console.log(`✓ Initialized Robin at ${userData}`);
  console.log(`  Database: ${dbFilePath(userData)}`);
  console.log(`  Config:   ${paths.config.root}`);
  console.log(`  Hardware: ${hw.profile} (${hw.cpu}, ${hw.ram_gb}GB)`);

  // Install + load launchd agent so the daemon autostarts (macOS only).
  // `--no-launchd` opts out; non-macOS platforms silently skip.
  let launchdInstalled = false;
  if (!opts.noLaunchd && platform() === 'darwin') {
    try {
      const spec = buildDaemonSpecFromEnv({ userDataDir: userData });
      const r = installDaemonLaunchd(spec);
      launchdInstalled = true;
      console.log(`  Launchd:  ${r.alreadyLoaded ? 'reloaded' : 'loaded'} ${r.plistPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Launchd:  skipped (${msg})`);
    }
  }

  // Register Robin's MCP servers in ~/.claude.json so Claude can reach memory
  // (mcp__robin__*) and integration ops (mcp__robin-extension__*) without a
  // separate `robin mcp install` step.
  try {
    const { buildRobinMcpEntry, upsertUserScopeMcp } = await import(
      '../../lib/mcp-config/write.ts'
    );
    const core = upsertUserScopeMcp(buildRobinMcpEntry({ surface: 'core' }), { name: 'robin' });
    upsertUserScopeMcp(buildRobinMcpEntry({ surface: 'extension' }), { name: 'robin-extension' });
    console.log(`  MCP:      registered robin + robin-extension in ${core.path}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  MCP:      skipped (${msg})`);
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
    console.log(
      `  Hooks:    ${end.replaced ? 'updated' : 'installed'} SessionEnd, ${start.replaced ? 'updated' : 'installed'} SessionStart in ${end.path}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Hooks:    skipped (${msg})`);
  }

  console.log('');
  console.log('Next steps:');
  if (launchdInstalled) {
    console.log('  - robin doctor                 # verify the daemon is active + online');
  } else {
    console.log('  - pnpm dev                     # run the foreground daemon (non-macOS)');
    console.log('  - robin doctor                 # verify');
  }
}
