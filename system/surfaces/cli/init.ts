import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath, resolveUserDataDir, userDataPaths } from '../../lib/paths.ts';

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
      `# Robin model adapter routing
# Configure provider integrations and role-based model selection here
roles: {}
`,
    );
  }

  // Apply schema migrations
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  closeDb(db);

  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`✓ Initialized Robin at ${userData}`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`  Database: ${dbFilePath(userData)}`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`  Config:   ${paths.config.root}`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`  Hardware: ${hw.profile} (${hw.cpu}, ${hw.ram_gb}GB)`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('');
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('Next steps:');
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('  - robin doctor                 # verify');
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('  - pnpm dev                     # foreground daemon (dev mode)');
}
