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
  if (cmd === 'migrate-from-v1') {
    const { migrateFromV1 } = await import('./commands/migrate-from-v1.js');
    return migrateFromV1(argv.slice(1));
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
  if (cmd === 'jobs') {
    const sub = argv[1];
    if (sub === 'list') {
      const { jobsList } = await import('./commands/jobs-list.js');
      return jobsList(argv.slice(2));
    }
    if (sub === 'status') {
      const { jobsStatus } = await import('./commands/jobs-status.js');
      return jobsStatus(argv.slice(2));
    }
    if (sub === 'run') {
      const { jobsRun } = await import('./commands/jobs-run.js');
      return jobsRun(argv.slice(2));
    }
    if (sub === 'enable') {
      const { jobsEnable } = await import('./commands/jobs-enable.js');
      return jobsEnable(argv.slice(2));
    }
    if (sub === 'disable') {
      const { jobsDisable } = await import('./commands/jobs-disable.js');
      return jobsDisable(argv.slice(2));
    }
    if (sub === 'reload') {
      const { jobsReload } = await import('./commands/jobs-reload.js');
      return jobsReload(argv.slice(2));
    }
    console.error('usage: robin jobs <list|status|run|enable|disable|reload>');
    process.exit(1);
  }
  if (cmd === 'ingest') {
    const { ingestCmd } = await import('./commands/ingest.js');
    return ingestCmd(argv.slice(1));
  }
  if (cmd === 'lint') {
    const { lintCmd } = await import('./commands/lint.js');
    return lintCmd(argv.slice(1));
  }
  if (cmd === 'audit') {
    const { auditCmd } = await import('./commands/audit.js');
    return auditCmd(argv.slice(1));
  }
  if (cmd === 'actions') {
    const sub = argv[1];
    if (sub === 'list') {
      const { actionsList } = await import('./commands/actions-list.js');
      return actionsList(argv.slice(2));
    }
    if (sub === 'show') {
      const { actionsShow } = await import('./commands/actions-show.js');
      return actionsShow(argv.slice(2));
    }
    if (sub === 'set') {
      const { actionsSet } = await import('./commands/actions-set.js');
      return actionsSet(argv.slice(2));
    }
    if (sub === 'reset') {
      const { actionsReset } = await import('./commands/actions-reset.js');
      return actionsReset(argv.slice(2));
    }
    console.error('usage: robin actions <list|show|set|reset>');
    process.exit(1);
  }
  if (cmd === 'commstyle') {
    const sub = argv[1];
    if (sub === 'show') {
      const { commstyleShow } = await import('./commands/commstyle-show.js');
      return commstyleShow(argv.slice(2));
    }
    if (sub === 'refresh') {
      const { commstyleRefresh } = await import('./commands/commstyle-refresh.js');
      return commstyleRefresh(argv.slice(2));
    }
    console.error('usage: robin commstyle <show|refresh>');
    process.exit(1);
  }
  if (cmd === 'integrations') {
    const sub = argv[1];
    if (sub === 'list') {
      const { integrationsList } = await import('./commands/integrations-list.js');
      return integrationsList(argv.slice(2));
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
    console.error(
      'usage: robin integrations <list [<name> | --filter <name>]|status|run|discord register-commands>',
    );
    process.exit(1);
  }
  if (cmd === 'auth') {
    const sub = argv[1];
    if (sub === 'google') {
      const { authGoogle } = await import('./commands/auth-google.js');
      return authGoogle(argv.slice(2));
    }
    if (sub === 'spotify') {
      const { authSpotify } = await import('./commands/auth-spotify.js');
      return authSpotify(argv.slice(2));
    }
    if (sub === 'whoop') {
      const { authWhoop } = await import('./commands/auth-whoop.js');
      return authWhoop(argv.slice(2));
    }
    console.error('usage: robin auth <google|spotify|whoop> [--code [<VALUE>]]');
    process.exit(1);
  }
  if (cmd === 'embedder') {
    if (argv[1] === 'switch') {
      const { embedderSwitch } = await import('./commands/embedder-switch.js');
      return embedderSwitch(argv.slice(2));
    }
    console.error('usage: robin embedder switch <mxbai-1024|qwen3-4096|gemini-3072>');
    process.exit(1);
  }
  if (cmd === 'secrets') {
    const sub = argv[1];
    if (sub === 'import') {
      const { secretsImport } = await import('./commands/secrets-import.js');
      return secretsImport(argv.slice(2));
    }
    if (sub === 'list') {
      const { secretsList } = await import('./commands/secrets-list.js');
      return secretsList();
    }
    if (sub === 'set') {
      const { secretsSet } = await import('./commands/secrets-set.js');
      return secretsSet(argv.slice(2));
    }
    console.error('usage: robin secrets <import --from <path>|list|set <KEY>>');
    process.exit(1);
  }
  if (cmd === 'hook') {
    const { hook } = await import('./commands/hook.js');
    return hook(argv.slice(1));
  }
  if (cmd === 'remember') {
    const { remember } = await import('./commands/remember.js');
    return remember(argv.slice(1));
  }
  if (cmd === 'sessions') {
    const { sessionsPurge } = await import('./commands/sessions-purge.js');
    return sessionsPurge(argv.slice(1));
  }
  if (cmd === 'refusals') {
    if (argv[1] === 'list') {
      const { refusalsList } = await import('./commands/refusals-list.js');
      return refusalsList(argv.slice(2));
    }
    console.error('usage: robin refusals list');
    process.exit(1);
  }
  if (cmd === 'db') {
    if (argv[1] === 'browse') {
      const { dbBrowse } = await import('./commands/db-browse.js');
      return dbBrowse(argv.slice(2));
    }
    console.error('usage: robin db browse');
    process.exit(1);
  }
  if (cmd === 'pre-commit') {
    const sub = argv[1];
    const subcommands = {
      install: 'pre-commit-install.js',
      uninstall: 'pre-commit-uninstall.js',
      run: 'pre-commit-run.js',
    };
    if (!subcommands[sub]) {
      console.error('usage: robin pre-commit <install|uninstall|run>');
      process.exit(1);
    }
    const mod = await import(`./commands/${subcommands[sub]}`);
    const fn = Object.values(mod)[0];
    return fn(argv.slice(2));
  }
  if (cmd === 'doctor') {
    const { doctor } = await import('./commands/doctor.js');
    return doctor(argv.slice(1));
  }
  if (cmd === 'hooks') {
    const sub = argv[1];
    if (sub === 'disable') {
      const { hooksDisable } = await import('./commands/hooks-disable.js');
      return hooksDisable(argv.slice(2));
    }
    if (sub === 'enable') {
      const { hooksEnable } = await import('./commands/hooks-enable.js');
      return hooksEnable(argv.slice(2));
    }
    console.error('usage: robin hooks <disable|enable> <phase>');
    process.exit(1);
  }
  console.error(`unknown command: ${cmd}`);
  console.error('run `robin --help` for usage');
  process.exit(1);
}
