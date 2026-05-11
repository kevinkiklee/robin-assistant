// Declarative CLI command registry. Replaces the if/else dispatch in
// index.js. Each leaf entry is { import, export, help? }. Groups have
// `subcommands` (recursive). Help output is auto-generated from this table.
//
// Adding a command: drop a file in ./commands/ that exports a named function,
// then add a registry entry pointing at it. No dispatch code changes.

export const commands = {
  install: { import: './commands/install.js', export: 'install', help: 'install Robin' },
  uninstall: { import: './commands/uninstall.js', export: 'uninstall', help: 'uninstall Robin' },
  migrate: {
    import: './commands/migrate.js',
    export: 'migrate',
    help: 'apply schema migrations',
  },
  doctor: { import: './commands/doctor.js', export: 'doctor', help: 'health check' },
  remember: { import: './commands/remember.js', export: 'remember', help: 'CLI memory write' },
  journal: { import: './commands/journal.js', export: 'journalCmd', help: 'recent capture' },
  hot: { import: './commands/hot.js', export: 'hotCmd', help: 'hot entities/topics' },
  ingest: { import: './commands/ingest.js', export: 'ingestCmd', help: 'ingest knowledge' },
  lint: { import: './commands/lint.js', export: 'lintCmd', help: 'lint knowledge' },
  audit: { import: './commands/audit.js', export: 'auditCmd', help: 'audit knowledge' },
  embeddings: {
    import: './commands/embeddings.js',
    export: 'embeddings',
    help: 'embedder profile ops',
  },
  hook: { import: './commands/hook.js', export: 'hook', help: 'internal hook handler' },
  sessions: {
    import: './commands/sessions-purge.js',
    export: 'sessionsPurge',
    help: 'list/purge sessions',
  },
  calibration: {
    import: './commands/calibration-show.js',
    export: 'calibrationShow',
    help: 'show calibration',
  },
  'biographer-catchup': {
    import: './commands/biographer-catchup.js',
    export: 'biographerCatchup',
    help: 'process pending events',
  },
  biographer: {
    help: 'biographer ops',
    subcommands: {
      'process-pending': {
        import: './commands/biographer-process-pending.js',
        export: 'biographerProcessPending',
      },
    },
  },
  mcp: {
    help: 'daemon control',
    subcommands: {
      start: { import: './commands/mcp-start.js', export: 'mcpStart' },
      stop: { import: './commands/mcp-stop.js', export: 'mcpStop' },
      status: { import: './commands/mcp-status.js', export: 'mcpStatus' },
      restart: { import: './commands/mcp-restart.js', export: 'mcpRestart' },
      'ensure-running': {
        import: './commands/mcp-ensure-running.js',
        export: 'mcpEnsureRunning',
      },
      install: { import: './commands/mcp-install.js', export: 'mcpInstall' },
      uninstall: { import: './commands/mcp-uninstall.js', export: 'mcpUninstall' },
    },
  },
  dream: {
    help: 'dream pipeline',
    subcommands: {
      run: { import: './commands/dream-run.js', export: 'dreamRun' },
    },
  },
  rules: {
    help: 'rule candidates + approved rules',
    subcommands: {
      pending: { import: './commands/rules-pending.js', export: 'rulesPending' },
      approve: { import: './commands/rules-approve.js', export: 'rulesApprove' },
      reject: { import: './commands/rules-reject.js', export: 'rulesReject' },
      list: { import: './commands/rules-list.js', export: 'rulesList' },
      deactivate: { import: './commands/rules-deactivate.js', export: 'rulesDeactivate' },
    },
  },
  jobs: {
    help: 'job runner',
    subcommands: {
      list: { import: './commands/jobs-list.js', export: 'jobsList' },
      status: { import: './commands/jobs-status.js', export: 'jobsStatus' },
      run: { import: './commands/jobs-run.js', export: 'jobsRun' },
      enable: { import: './commands/jobs-enable.js', export: 'jobsEnable' },
      disable: { import: './commands/jobs-disable.js', export: 'jobsDisable' },
      reload: { import: './commands/jobs-reload.js', export: 'jobsReload' },
    },
  },
  actions: {
    help: 'action trust',
    subcommands: {
      list: { import: './commands/actions-list.js', export: 'actionsList' },
      show: { import: './commands/actions-show.js', export: 'actionsShow' },
      set: { import: './commands/actions-set.js', export: 'actionsSet' },
      reset: { import: './commands/actions-reset.js', export: 'actionsReset' },
    },
  },
  commstyle: {
    help: 'communication style profile',
    subcommands: {
      show: { import: './commands/commstyle-show.js', export: 'commstyleShow' },
      refresh: { import: './commands/commstyle-refresh.js', export: 'commstyleRefresh' },
    },
  },
  predictions: {
    help: 'predictions',
    subcommands: {
      list: { import: './commands/predictions-list.js', export: 'predictionsList' },
      resolve: { import: './commands/predictions-resolve.js', export: 'predictionsResolve' },
    },
  },
  integrations: {
    help: 'integration management',
    subcommands: {
      list: { import: './commands/integrations-list.js', export: 'integrationsList' },
      status: { import: './commands/integrations-status.js', export: 'integrationsStatus' },
      run: { import: './commands/integrations-run.js', export: 'integrationsRun' },
      discord: {
        help: 'discord-specific',
        subcommands: {
          'register-commands': {
            import: './commands/integrations-discord-register.js',
            export: 'integrationsDiscordRegister',
          },
        },
      },
    },
  },
  auth: {
    help: 'oauth setup',
    subcommands: {
      google: { import: './commands/auth-google.js', export: 'authGoogle' },
      spotify: { import: './commands/auth-spotify.js', export: 'authSpotify' },
      whoop: { import: './commands/auth-whoop.js', export: 'authWhoop' },
    },
  },
  secrets: {
    help: 'secrets management',
    subcommands: {
      import: { import: './commands/secrets-import.js', export: 'secretsImport' },
      list: { import: './commands/secrets-list.js', export: 'secretsList' },
      set: { import: './commands/secrets-set.js', export: 'secretsSet' },
    },
  },
  refusals: {
    help: 'refusal audit',
    subcommands: {
      list: { import: './commands/refusals-list.js', export: 'refusalsList' },
    },
  },
  'pre-commit': {
    help: 'per-repo pre-commit hook',
    subcommands: {
      install: { import: './commands/pre-commit-install.js', export: 'preCommitInstall' },
      uninstall: {
        import: './commands/pre-commit-uninstall.js',
        export: 'preCommitUninstall',
      },
      run: { import: './commands/pre-commit-run.js', export: 'preCommitRun' },
    },
  },
  hooks: {
    help: 'hook kill switch',
    subcommands: {
      disable: { import: './commands/hooks-disable.js', export: 'hooksDisable' },
      enable: { import: './commands/hooks-enable.js', export: 'hooksEnable' },
    },
  },
};
