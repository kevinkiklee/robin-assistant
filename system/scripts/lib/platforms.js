export const PLATFORMS = {
  'claude-code': {
    pointerFile: 'CLAUDE.md',
    pointerContent: 'Read and follow AGENTS.md for all instructions.\nAfter every response, scan for capturable signals and write to user-data/inbox.md with tags.\n',
    nativeIntegrations: {
      email: 'gmail (native via mcp__claude_ai_Gmail__)',
      calendar: 'google-calendar (native via mcp__claude_ai_Google_Calendar__)',
      storage: 'google-drive (native via mcp__claude_ai_Google_Drive__)',
    },
  },
  'cursor': {
    pointerFile: '.cursorrules',
    pointerContent: 'Read and follow AGENTS.md for all instructions.\nAfter every response, scan for capturable signals and write to user-data/inbox.md with tags.\n',
    nativeIntegrations: {},
  },
  'gemini-cli': {
    pointerFile: 'GEMINI.md',
    pointerContent: 'Read and follow AGENTS.md for all instructions.\nAfter every response, scan for capturable signals and write to user-data/inbox.md with tags.\n',
    nativeIntegrations: {},
  },
  'codex': {
    pointerFile: null,
    pointerContent: null,
    nativeIntegrations: {},
  },
  'windsurf': {
    pointerFile: '.windsurfrules',
    pointerContent: 'Read and follow AGENTS.md for all instructions.\nAfter every response, scan for capturable signals and write to user-data/inbox.md with tags.\n',
    nativeIntegrations: {},
  },
  'antigravity': {
    pointerFile: null,
    pointerContent: null,
    nativeIntegrations: {},
  },
};

export const ALL_INTEGRATIONS = [
  'email', 'calendar', 'storage', 'weather', 'maps', 'health', 'finance', 'browser'
];

export const SYSTEM_FILES = ['startup.md', 'capture-rules.md'];

export const USER_DATA_FILES = [
  'profile.md', 'tasks.md', 'knowledge.md', 'decisions.md',
  'journal.md', 'self-improvement.md', 'inbox.md',
];

export const INDEX_FILES = [
  'index/profile.idx.md', 'index/knowledge.idx.md', 'index/tasks.idx.md',
  'index/journal.idx.md', 'index/decisions.idx.md', 'index/self-improvement.idx.md',
  'index/inbox.idx.md', 'index/trips.idx.md',
];

export function generateIntegrationsMd(platform, enabledIntegrations) {
  const platformConfig = PLATFORMS[platform];
  const lines = ['# Integrations', '', `Platform: ${platform}`, '', '## Available'];

  for (const key of enabledIntegrations) {
    const native = platformConfig.nativeIntegrations[key];
    if (native) {
      lines.push(`- ${key}: ${native}`);
    } else {
      lines.push(`- ${key}: user-provided (paste or summarize)`);
    }
  }

  const notConfigured = ALL_INTEGRATIONS.filter(i => !enabledIntegrations.includes(i));
  lines.push('', '## Not configured');
  lines.push(notConfigured.length ? `- ${notConfigured.join(', ')}` : '- (none)');

  lines.push('', '## Fallback behavior');
  lines.push('For any integration not listed above, protocols will ask the user');
  lines.push('to provide the information directly (paste, summarize, or screenshot).');
  lines.push('');

  return lines.join('\n');
}
