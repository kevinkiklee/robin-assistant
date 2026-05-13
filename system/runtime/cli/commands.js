// Declarative CLI command registry. Replaces the if/else dispatch in
// index.js. Each leaf entry is { import, export, help? }. Groups have
// `subcommands` (recursive). Help output is auto-generated from this table.
//
// Adding a command: drop a file in ./commands/ that exports a named function,
// then add a registry entry pointing at it. No dispatch code changes.

export const commands = {
  install: {
    import: './commands/install.js',
    export: 'install',
    help: 'install Robin',
  },
  uninstall: {
    import: './commands/uninstall.js',
    export: 'uninstall',
    help: 'uninstall Robin',
  },
  migrate: {
    import: './commands/migrate.js',
    export: 'migrate',
    help: 'apply schema migrations',
  },
  'migrate-user-data': {
    import: './commands/migrate-user-data.js',
    export: 'migrateUserData',
    help: 'migrate user-data layout from v1 to v2 (idempotent; --dry-run supported)',
  },
  'import-v1': {
    import: './commands/import-v1.js',
    export: 'importV1',
    help: 'import v1 markdown user-data into v2',
  },
  doctor: {
    import: './commands/doctor.js',
    export: 'doctor',
    help: 'health check',
  },
  'recall-eval': {
    import: './commands/recall-eval.js',
    export: 'recallEval',
    help: 'recall eval harness (A3)',
  },
  remember: {
    import: './commands/remember.js',
    export: 'remember',
    help: 'CLI memory write',
  },
  journal: {
    import: './commands/journal.js',
    export: 'journalCmd',
    help: 'recent capture',
  },
  hot: {
    import: './commands/hot.js',
    export: 'hotCmd',
    help: 'hot entities/topics',
  },
  ingest: {
    import: './commands/ingest.js',
    export: 'ingestCmd',
    help: 'ingest knowledge',
  },
  lint: {
    import: './commands/lint.js',
    export: 'lintCmd',
    help: 'lint knowledge',
  },
  audit: {
    import: './commands/audit.js',
    export: 'auditCmd',
    help: 'audit knowledge',
  },
  embeddings: {
    import: './commands/embeddings.js',
    export: 'embeddings',
    help: 'embedder profile ops',
  },
  hook: {
    import: './commands/hook.js',
    export: 'hook',
    help: 'internal hook handler',
  },
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
        help: 'flush queued raw events into biographed memos',
      },
    },
  },
  mcp: {
    help: 'daemon control',
    subcommands: {
      start: {
        import: './commands/mcp-start.js',
        export: 'mcpStart',
        help: 'spawn the daemon (foreground unless detached)',
      },
      stop: {
        import: './commands/mcp-stop.js',
        export: 'mcpStop',
        help: 'stop the running daemon',
      },
      status: {
        import: './commands/mcp-status.js',
        export: 'mcpStatus',
        help: 'print daemon port + pid + uptime',
      },
      restart: {
        import: './commands/mcp-restart.js',
        export: 'mcpRestart',
        help: 'stop then start the daemon',
      },
      'ensure-running': {
        import: './commands/mcp-ensure-running.js',
        export: 'mcpEnsureRunning',
        help: 'start the daemon if not already running (idempotent)',
      },
      install: {
        import: './commands/mcp-install.js',
        export: 'mcpInstall',
        help: 'install launchd/systemd supervisor + register MCP with hosts',
      },
      uninstall: {
        import: './commands/mcp-uninstall.js',
        export: 'mcpUninstall',
        help: 'remove supervisor + host MCP registration',
      },
    },
  },
  dream: {
    help: 'dream pipeline',
    subcommands: {
      run: {
        import: './commands/dream-run.js',
        export: 'dreamRun',
        help: 'run the dream consolidation pipeline once',
      },
    },
  },
  rules: {
    help: 'rule candidates + approved rules',
    subcommands: {
      pending: {
        import: './commands/rules-pending.js',
        export: 'rulesPending',
        help: 'list rule candidates awaiting review',
      },
      approve: {
        import: './commands/rules-approve.js',
        export: 'rulesApprove',
        help: 'approve a rule candidate by id',
      },
      reject: {
        import: './commands/rules-reject.js',
        export: 'rulesReject',
        help: 'reject a rule candidate by id',
      },
      list: {
        import: './commands/rules-list.js',
        export: 'rulesList',
        help: 'list approved/active rules',
      },
      deactivate: {
        import: './commands/rules-deactivate.js',
        export: 'rulesDeactivate',
        help: 'deactivate an approved rule',
      },
    },
  },
  jobs: {
    help: 'job runner',
    subcommands: {
      list: {
        import: './commands/jobs-list.js',
        export: 'jobsList',
        help: 'list registered jobs + schedules',
      },
      status: {
        import: './commands/jobs-status.js',
        export: 'jobsStatus',
        help: 'recent runs + state per job',
      },
      run: {
        import: './commands/jobs-run.js',
        export: 'jobsRun',
        help: 'run a job by name immediately',
      },
      enable: {
        import: './commands/jobs-enable.js',
        export: 'jobsEnable',
        help: 'enable a disabled job',
      },
      disable: {
        import: './commands/jobs-disable.js',
        export: 'jobsDisable',
        help: 'disable a job (skips its tick)',
      },
      reload: {
        import: './commands/jobs-reload.js',
        export: 'jobsReload',
        help: 'reload job definitions in the daemon',
      },
    },
  },
  actions: {
    help: 'action trust',
    subcommands: {
      list: {
        import: './commands/actions-list.js',
        export: 'actionsList',
        help: 'list action-trust classes and states',
      },
      show: {
        import: './commands/actions-show.js',
        export: 'actionsShow',
        help: 'show ledger entries for a class',
      },
      set: {
        import: './commands/actions-set.js',
        export: 'actionsSet',
        help: 'set the trust state for a class',
      },
      reset: {
        import: './commands/actions-reset.js',
        export: 'actionsReset',
        help: 'reset a class back to ASK',
      },
    },
  },
  commstyle: {
    help: 'communication style profile',
    subcommands: {
      show: {
        import: './commands/commstyle-show.js',
        export: 'commstyleShow',
        help: 'show the current comm-style profile',
      },
      refresh: {
        import: './commands/commstyle-refresh.js',
        export: 'commstyleRefresh',
        help: 'recompute the comm-style profile from recent sessions',
      },
    },
  },
  predictions: {
    help: 'predictions',
    subcommands: {
      list: {
        import: './commands/predictions-list.js',
        export: 'predictionsList',
        help: 'list open / resolved predictions',
      },
      resolve: {
        import: './commands/predictions-resolve.js',
        export: 'predictionsResolve',
        help: 'resolve a prediction (correct/incorrect/unknown)',
      },
    },
  },
  integrations: {
    help: 'integration management',
    subcommands: {
      list: {
        import: './commands/integrations-list.js',
        export: 'integrationsList',
        help: 'list integrations + their availability',
      },
      status: {
        import: './commands/integrations-status.js',
        export: 'integrationsStatus',
        help: 'show per-integration last-tick / errors',
      },
      run: {
        import: './commands/integrations-run.js',
        export: 'integrationsRun',
        help: 'force-run an integration tick',
      },
      discord: {
        help: 'discord-specific',
        subcommands: {
          'register-commands': {
            import: './commands/integrations-discord-register.js',
            export: 'integrationsDiscordRegister',
            help: 'register Discord slash commands with the bot',
          },
        },
      },
    },
  },
  auth: {
    help: 'oauth setup',
    subcommands: {
      google: {
        import: './commands/auth-google.js',
        export: 'authGoogle',
        help: 'OAuth flow for Gmail/Calendar/Drive',
      },
      spotify: {
        import: './commands/auth-spotify.js',
        export: 'authSpotify',
        help: 'OAuth flow for Spotify',
      },
      whoop: {
        import: './commands/auth-whoop.js',
        export: 'authWhoop',
        help: 'OAuth flow for Whoop',
      },
    },
  },
  secrets: {
    help: 'secrets management',
    subcommands: {
      import: {
        import: './commands/secrets-import.js',
        export: 'secretsImport',
        help: 'import secrets from another .env file',
      },
      list: {
        import: './commands/secrets-list.js',
        export: 'secretsList',
        help: 'list secret keys (values redacted)',
      },
      set: {
        import: './commands/secrets-set.js',
        export: 'secretsSet',
        help: 'set a secret (KEY=value or interactive)',
      },
    },
  },
  refusals: {
    help: 'refusal audit',
    subcommands: {
      list: {
        import: './commands/refusals-list.js',
        export: 'refusalsList',
        help: 'list recent refusals (PII guard, etc.)',
      },
    },
  },
  'pre-commit': {
    help: 'per-repo pre-commit hook',
    subcommands: {
      install: {
        import: './commands/pre-commit-install.js',
        export: 'preCommitInstall',
        help: 'install Robin pre-commit hook in current repo',
      },
      uninstall: {
        import: './commands/pre-commit-uninstall.js',
        export: 'preCommitUninstall',
        help: 'remove the Robin pre-commit hook from current repo',
      },
      run: {
        import: './commands/pre-commit-run.js',
        export: 'preCommitRun',
        help: 'run the pre-commit checks manually',
      },
    },
  },
  hooks: {
    help: 'hook kill switch',
    subcommands: {
      disable: {
        import: './commands/hooks-disable.js',
        export: 'hooksDisable',
        help: 'disable Robin hooks for current shell/session',
      },
      enable: {
        import: './commands/hooks-enable.js',
        export: 'hooksEnable',
        help: 're-enable Robin hooks',
      },
    },
  },
};
