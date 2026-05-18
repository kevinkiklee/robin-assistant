// Hand-authored CLI command registry. Drives the `Related:` footer in
// `--help` output. Group siblings appear under `Related:` (excluding self).
// Add new commands here as they ship.

export const COMMAND_REGISTRY = [
  // jobs group
  { name: 'jobs-list', summary: 'List scheduled background jobs.', group: 'jobs' },
  { name: 'jobs-run', summary: 'Manually run a job by name.', group: 'jobs' },
  { name: 'jobs-status', summary: 'Show job execution history + next runs.', group: 'jobs' },
  { name: 'jobs-enable', summary: 'Enable a disabled job.', group: 'jobs' },
  { name: 'jobs-disable', summary: 'Disable a scheduled job without removing it.', group: 'jobs' },
  { name: 'jobs-reload', summary: 'Reload job definitions from user-data/jobs.', group: 'jobs' },

  // integrations group
  { name: 'integrations-list', summary: 'List configured integrations.', group: 'integrations' },
  {
    name: 'integrations-status',
    summary: 'Show last-sync state per integration.',
    group: 'integrations',
  },
  { name: 'integrations-run', summary: 'Manually trigger a sync.', group: 'integrations' },
  { name: 'integrations-enable', summary: 'Enable a disabled integration.', group: 'integrations' },
  {
    name: 'integrations-disable',
    summary: 'Disable an integration without removing config.',
    group: 'integrations',
  },
  {
    name: 'integrations-migrate',
    summary: 'Run integration schema migrations.',
    group: 'integrations',
  },
  {
    name: 'integrations-discord-register',
    summary: 'Register Discord bot for this user.',
    group: 'integrations',
  },

  // embeddings group
  {
    name: 'embeddings',
    summary: 'Manage embedder profiles + backfill operations.',
    group: 'embeddings',
  },

  // actions group
  { name: 'actions-list', summary: 'List action-trust class policies.', group: 'actions' },
  { name: 'actions-set', summary: 'Set policy for a (tool, action) class.', group: 'actions' },
  { name: 'actions-show', summary: 'Show policy for a single action class.', group: 'actions' },
  { name: 'actions-reset', summary: 'Reset a class to default ASK policy.', group: 'actions' },

  // brief group
  {
    name: 'brief-regenerate',
    summary: 'Regenerate the daily brief from cached data.',
    group: 'brief',
  },
  {
    name: 'brief-calibrate',
    summary: 'Score recent briefs and update brief calibration.',
    group: 'brief',
  },
  { name: 'brief-feedback', summary: 'Record user feedback on a brief.', group: 'brief' },
  { name: 'brief-gallery', summary: 'Open the brief gallery for review.', group: 'brief' },

  // mcp group
  {
    name: 'mcp-install',
    summary: 'Wire MCP server entry into ~/.claude.json and .mcp.json.',
    group: 'mcp',
  },
  { name: 'mcp-start', summary: 'Start the MCP daemon (foreground or background).', group: 'mcp' },
  { name: 'mcp-stop', summary: 'Stop the running MCP daemon.', group: 'mcp' },
  { name: 'mcp-restart', summary: 'Stop + start the MCP daemon.', group: 'mcp' },
  { name: 'mcp-uninstall', summary: 'Remove MCP wiring + stop daemon.', group: 'mcp' },
  { name: 'mcp-ensure-running', summary: 'Ensure MCP daemon is up; start if not.', group: 'mcp' },
  { name: 'mcp-status', summary: 'Show MCP daemon status (pid, port, uptime).', group: 'mcp' },

  // auth group
  {
    name: 'auth-google',
    summary: 'Run Google OAuth flow (Gmail + Calendar + Drive).',
    group: 'auth',
  },
  { name: 'auth-spotify', summary: 'Run Spotify OAuth flow.', group: 'auth' },
  { name: 'auth-whoop', summary: 'Run Whoop OAuth flow.', group: 'auth' },

  // pre-commit group
  {
    name: 'pre-commit-install',
    summary: 'Install Robin pre-commit hook into .githooks.',
    group: 'pre-commit',
  },
  {
    name: 'pre-commit-run',
    summary: 'Run pre-commit checks against staged files.',
    group: 'pre-commit',
  },
  { name: 'pre-commit-uninstall', summary: 'Remove Robin pre-commit hook.', group: 'pre-commit' },

  // hooks group (Claude Code / Gemini host hooks)
  { name: 'hooks-enable', summary: 'Enable Robin host hooks for this user.', group: 'hooks' },
  { name: 'hooks-disable', summary: 'Disable Robin host hooks for this user.', group: 'hooks' },
  { name: 'hook', summary: 'Internal hook entry point (invoked by host).', group: 'hooks' },

  // biographer group
  {
    name: 'biographer-catchup',
    summary: 'Process backlog of pending captures.',
    group: 'biographer',
  },
  {
    name: 'biographer-process-pending',
    summary: 'Drain the pending biographer queue.',
    group: 'biographer',
  },

  // dream group
  { name: 'dream-run', summary: 'Internal entry — run a single dream step.', group: 'dream' },

  // calibration / predictions / commstyle
  {
    name: 'calibration-show',
    summary: 'Show prediction calibration metrics.',
    group: 'calibration',
  },
  { name: 'predictions-list', summary: 'List open / resolved predictions.', group: 'calibration' },
  {
    name: 'predictions-resolve',
    summary: 'Resolve an open prediction as correct or wrong.',
    group: 'calibration',
  },
  {
    name: 'commstyle-refresh',
    summary: 'Force recompute of comm-style snapshot.',
    group: 'commstyle',
  },
  { name: 'commstyle-show', summary: 'Show current comm-style snapshot.', group: 'commstyle' },

  // secrets group
  { name: 'secrets-import', summary: 'Import secrets from a key=value file.', group: 'secrets' },
  {
    name: 'secrets-list',
    summary: 'List secret keys configured in the secrets store.',
    group: 'secrets',
  },
  { name: 'secrets-set', summary: 'Set or update a single secret key.', group: 'secrets' },

  // rules group
  { name: 'rules-list', summary: 'List behavior rules by status.', group: 'rules' },
  { name: 'rules-approve', summary: 'Approve a pending rule candidate.', group: 'rules' },
  { name: 'rules-reject', summary: 'Reject a pending rule candidate.', group: 'rules' },
  {
    name: 'rules-deactivate',
    summary: 'Deactivate an active rule without deleting it.',
    group: 'rules',
  },
  { name: 'rules-pending', summary: 'List rule candidates awaiting approval.', group: 'rules' },

  // refusals group
  { name: 'refusals-list', summary: 'Show recent refusal events.', group: 'introspect' },

  // remember
  { name: 'remember', summary: 'Capture a noteworthy fact into memory.', group: 'introspect' },

  // sessions group
  { name: 'sessions-purge', summary: 'Purge stale session records.', group: 'sessions' },

  // install / runtime group
  { name: 'install', summary: 'Install Robin pointer + skeleton + schema.', group: 'install' },
  { name: 'uninstall', summary: 'Reverse install.', group: 'install' },
  { name: 'migrate', summary: 'Apply DB schema migrations.', group: 'install' },
  { name: 'migrate-user-data', summary: 'Apply user-data layout migrations.', group: 'install' },
  { name: 'version', summary: 'Print Robin version + paths.', group: 'install' },
  { name: 'doctor', summary: 'Run health probes + print report.', group: 'install' },
  { name: 'surreal-install', summary: 'Install the embedded SurrealDB binary.', group: 'install' },
  {
    name: 'surreal-ensure-running',
    summary: 'Ensure SurrealDB is up; start if not.',
    group: 'install',
  },
  { name: 'import-v1', summary: 'Import data from a v1 Robin instance.', group: 'install' },

  // introspect group
  { name: 'hot', summary: 'Print last N events from event stream.', group: 'introspect' },
  { name: 'journal', summary: 'Print episode + capture timeline.', group: 'introspect' },
  { name: 'audit', summary: 'Run contradiction audit across knowledge.', group: 'introspect' },
  { name: 'lint', summary: 'Run mechanical memory lint.', group: 'introspect' },
  { name: 'ingest', summary: 'Ingest a file/URL/content into memory.', group: 'introspect' },
  {
    name: 'recall-eval',
    summary: 'Evaluate recall quality against a corpus.',
    group: 'introspect',
  },

  // publishing group
  { name: 'publish', summary: 'Publish a markdown artifact to the web.', group: 'publishing' },
  {
    name: 'published',
    summary: 'List pages published from this Robin instance.',
    group: 'publishing',
  },

  // web admin UI
  { name: 'web', summary: 'Start the local web admin UI.', group: 'web' },

  // help
  { name: 'help', summary: 'Print top-level help.', group: 'help' },
];

const BY_GROUP = (() => {
  const m = new Map();
  for (const entry of COMMAND_REGISTRY) {
    if (!m.has(entry.group)) m.set(entry.group, []);
    m.get(entry.group).push(entry.name);
  }
  return m;
})();

export function relatedFor(name) {
  const entry = COMMAND_REGISTRY.find((e) => e.name === name);
  if (!entry) return [];
  if (entry.siblings) return entry.siblings;
  return (BY_GROUP.get(entry.group) ?? []).filter((n) => n !== name);
}

// Map registry names (flat, e.g. `jobs-list`) to argv (hierarchical, e.g.
// `jobs list`). Most entries are derived by replacing the first `-` with a
// space; exceptions are listed explicitly. Names not in the dispatch tree
// (e.g. obsolete entries or pure aliases) map to null.
const ARGV_OVERRIDES = {
  // top-level commands kept as a single token
  remember: ['remember'],
  hot: ['hot'],
  journal: ['journal'],
  audit: ['audit'],
  lint: ['lint'],
  ingest: ['ingest'],
  'recall-eval': ['recall-eval'],
  install: ['install'],
  uninstall: ['uninstall'],
  migrate: ['migrate'],
  'migrate-user-data': ['migrate-user-data'],
  'import-v1': ['import-v1'],
  doctor: ['doctor'],
  embeddings: ['embeddings'],
  hook: ['hook'],
  publish: ['publish'],
  published: ['published'],
  'biographer-catchup': ['biographer-catchup'],
  'biographer-process-pending': ['biographer', 'process-pending'],
  'calibration-show': ['calibration'],
  'sessions-purge': ['sessions'],
  'integrations-discord-register': ['integrations', 'discord', 'register-commands'],
  help: ['--help'],
  // pre-commit is a two-token group name
  'pre-commit-install': ['pre-commit', 'install'],
  'pre-commit-run': ['pre-commit', 'run'],
  'pre-commit-uninstall': ['pre-commit', 'uninstall'],
  // commands present in registry but not dispatchable (defunct or top-level
  // CLI flags handled in index.js); listed for completeness.
  version: null,
  'surreal-install': null,
  'surreal-ensure-running': null,
  'brief-gallery': null,
  'mcp-ensure-running': null,
};

// Derive default argv: split on first dash. e.g. `jobs-list` → ['jobs', 'list'].
function defaultArgv(name) {
  const idx = name.indexOf('-');
  if (idx === -1) return [name];
  return [name.slice(0, idx), name.slice(idx + 1)];
}

export function argvFor(name) {
  if (Object.hasOwn(ARGV_OVERRIDES, name)) return ARGV_OVERRIDES[name];
  return defaultArgv(name);
}
