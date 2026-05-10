import { help } from './commands/help.js';
import { version } from './commands/version.js';

export async function main(argv) {
  const [cmd] = argv;
  if (cmd === '--version' || cmd === '-v') return version();
  if (cmd === '--help' || cmd === '-h' || cmd === undefined) return help();
  if (cmd === 'migrate') {
    const { migrate } = await import('./commands/migrate.js');
    return migrate();
  }
  if (cmd === 'install') {
    const { install } = await import('./commands/install.js');
    return install(argv.slice(1));
  }
  if (cmd === 'uninstall') {
    const { uninstall } = await import('./commands/uninstall.js');
    return uninstall();
  }
  if (cmd === 'biographer-catchup') {
    const { biographerCatchup } = await import('./commands/biographer-catchup.js');
    return biographerCatchup(argv.slice(1));
  }
  if (cmd === 'biographer') {
    const sub = argv[1];
    if (sub === 'process-pending') {
      const { biographerProcessPending } = await import('./commands/biographer-process-pending.js');
      return biographerProcessPending(argv.slice(2));
    }
    console.error(`unknown biographer subcommand: ${sub}`);
    process.exit(1);
  }
  if (cmd === 'mcp') {
    const sub = argv[1];
    const subcommands = {
      start: 'mcp-start.js',
      stop: 'mcp-stop.js',
      status: 'mcp-status.js',
      restart: 'mcp-restart.js',
      'ensure-running': 'mcp-ensure-running.js',
      install: 'mcp-install.js',
      uninstall: 'mcp-uninstall.js',
    };
    if (!subcommands[sub]) {
      console.error(`unknown mcp subcommand: ${sub}`);
      process.exit(1);
    }
    const mod = await import(`./commands/${subcommands[sub]}`);
    const fn = Object.values(mod)[0];
    return fn(argv.slice(2));
  }
  if (cmd === 'dream') {
    if (argv[1] === 'run') {
      const { dreamRun } = await import('./commands/dream-run.js');
      return dreamRun();
    }
    console.error('usage: robin dream run');
    process.exit(1);
  }
  if (cmd === 'rules') {
    const sub = argv[1];
    const subcommands = {
      pending: 'rules-pending.js',
      approve: 'rules-approve.js',
      reject: 'rules-reject.js',
      list: 'rules-list.js',
      deactivate: 'rules-deactivate.js',
    };
    if (!subcommands[sub]) {
      console.error(`unknown rules subcommand: ${sub}`);
      process.exit(1);
    }
    const mod = await import(`./commands/${subcommands[sub]}`);
    const fn = Object.values(mod)[0];
    return fn(argv.slice(2));
  }
  if (cmd === 'journal') {
    const { journalCmd } = await import('./commands/journal.js');
    return journalCmd(argv.slice(1));
  }
  if (cmd === 'hot') {
    const { hotCmd } = await import('./commands/hot.js');
    return hotCmd();
  }
  if (cmd === 'auth') {
    const sub = argv[1];
    const subcommands = {
      gmail: 'auth-gmail.js',
      lunch_money: 'auth-lunch-money.js',
      discord: 'auth-discord.js',
    };
    if (!subcommands[sub]) {
      console.error('usage: robin auth <gmail|lunch_money|discord>');
      process.exit(1);
    }
    const mod = await import(`./commands/${subcommands[sub]}`);
    const fn = Object.values(mod)[0];
    return fn(argv.slice(2));
  }
  if (cmd === 'integrations') {
    const sub = argv[1];
    if (sub === 'list') {
      const { integrationsList } = await import('./commands/integrations-list.js');
      return integrationsList();
    }
    if (sub === 'status') {
      const { integrationsStatus } = await import('./commands/integrations-status.js');
      return integrationsStatus(argv.slice(2));
    }
    if (sub === 'run') {
      const { integrationsRun } = await import('./commands/integrations-run.js');
      return integrationsRun(argv.slice(2));
    }
    if (sub === 'discord' && argv[2] === 'register-commands') {
      const { integrationsDiscordRegister } = await import(
        './commands/integrations-discord-register.js'
      );
      return integrationsDiscordRegister();
    }
    console.error('usage: robin integrations <list|status|run|discord register-commands>');
    process.exit(1);
  }
  console.error(`unknown command: ${cmd}`);
  console.error('run `robin --help` for usage');
  process.exit(1);
}
