#!/usr/bin/env node

import { program } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..');

program
  .name('robin')
  .description('A self-improving personal assistant — portable across AI coding tools')
  .version('2.1.0');

program
  .command('init [directory]')
  .description('Scaffold a new Robin workspace')
  .option('--force', 'Allow init in non-empty directory')
  .option('--platform <platform>', 'AI tool platform (claude-code, cursor, gemini-cli, codex, windsurf, antigravity)')
  .action(async (directory, options) => {
    const { init } = await import(join(PKG_ROOT, 'scripts', 'init.js'));
    await init(directory || '.', options, PKG_ROOT);
  });

program
  .command('configure')
  .description('Update workspace configuration')
  .option('--name <name>', 'User name')
  .option('--timezone <tz>', 'Timezone (IANA format)')
  .option('--email <email>', 'Email address')
  .option('--assistant-name <name>', 'Assistant name (default: Robin)')
  .option('--platform <platform>', 'Switch AI tool platform')
  .option('--add-integration <name>', 'Add an integration (email, calendar, storage, etc.)')
  .option('--remove-integration <name>', 'Remove an integration')
  .action(async (options) => {
    const { configure } = await import(join(PKG_ROOT, 'scripts', 'configure.js'));
    await configure(options, PKG_ROOT);
  });

program
  .command('update')
  .description('Update system files and protocols to the latest version')
  .action(async () => {
    const { update } = await import(join(PKG_ROOT, 'scripts', 'update.js'));
    await update(PKG_ROOT);
  });

program
  .command('check-update')
  .description('Check for available updates')
  .action(async () => {
    const { checkUpdate } = await import(join(PKG_ROOT, 'scripts', 'check-update.js'));
    await checkUpdate(PKG_ROOT);
  });

program
  .command('rollback')
  .description('Restore from the most recent backup')
  .action(async () => {
    const { rollback } = await import(join(PKG_ROOT, 'scripts', 'rollback.js'));
    await rollback(PKG_ROOT);
  });

program
  .command('validate')
  .description('Check workspace integrity')
  .action(async () => {
    const { validate } = await import(join(PKG_ROOT, 'scripts', 'validate.js'));
    await validate();
  });

program
  .command('export')
  .description('Export all user data as a portable archive')
  .action(async () => {
    const { exportData } = await import(join(PKG_ROOT, 'scripts', 'export.js'));
    await exportData();
  });

program
  .command('reset')
  .description('Wipe user data files back to defaults')
  .action(async () => {
    const { reset } = await import(join(PKG_ROOT, 'scripts', 'reset.js'));
    await reset(PKG_ROOT);
  });

program
  .command('migrate-index')
  .description('Add memory indexing to an existing workspace (v2.0.0 → v2.1.0)')
  .action(async () => {
    const { migrateIndex } = await import(join(PKG_ROOT, 'scripts', 'migrate-index.js'));
    await migrateIndex(PKG_ROOT);
  });

program
  .command('version')
  .description('Show current version')
  .action(() => {
    console.log('robin-assistant v2.1.0');
  });

program.parse();
