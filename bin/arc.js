#!/usr/bin/env node

import { program } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..');

program
  .name('arc')
  .description('A self-improving personal assistant powered by Claude Code')
  .version('1.0.0');

program
  .command('init [directory]')
  .description('Scaffold a new Arc workspace')
  .option('--force', 'Allow init in non-empty directory')
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
  .option('--assistant-name <name>', 'Assistant name (default: Arc)')
  .action(async (options) => {
    const { configure } = await import(join(PKG_ROOT, 'scripts', 'configure.js'));
    await configure(options, PKG_ROOT);
  });

program
  .command('update')
  .description('Update core/ to the latest version')
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
  .description('Restore core/ from the most recent backup')
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
  .description('Wipe all user data, keep core/')
  .action(async () => {
    const { reset } = await import(join(PKG_ROOT, 'scripts', 'reset.js'));
    await reset(PKG_ROOT);
  });

program.parse();
