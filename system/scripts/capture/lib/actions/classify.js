// Deterministically map a tool call shape to an action class slug.
//
// Slug format: <provider>-<verb>[-<qualifier>], all lowercase, kebab-case.
// Pure read tools (Read, Grep, Glob, etc.) return null — they are not
// "actions" for the policies/trust system.
//
// The slug is the durable identifier in policies.md and action-trust.md.
// Avoid LLM judgment in the name so two sessions name the same call the
// same way.

const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoRead',
  'TaskOutput',
  'TaskList',
  'TaskGet',
]);

// Convert a string to lowercase kebab-case.
// Underscores become dashes; consecutive dashes collapse.
// CamelCase is NOT split — brand names like "GitHub" become "github",
// not "git-hub". The MCP provider segment uses underscore-separated words
// (e.g. "Google_Calendar") which are handled by the underscore→dash path.
function kebab(s) {
  return s
    .replace(/_/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

function mcpSlug(name) {
  // Examples:
  //   mcp__claude_ai_Gmail__archive           -> gmail-archive
  //   mcp__claude_ai_Google_Calendar__create  -> google-calendar-create
  //   mcp__GitHub__create_issue               -> github-create-issue
  const stripped = name.replace(/^mcp__/, '');
  const parts = stripped.split('__');
  if (parts.length < 2) return kebab(stripped);
  let provider = parts[0]
    .replace(/^claude_ai_/i, '')
    .replace(/^claude_/i, '');
  const verb = parts.slice(1).join('-');
  return `${kebab(provider)}-${kebab(verb)}`;
}

function bashSlug(input) {
  const cmd = (input?.command ?? '').trim();
  if (!cmd) return 'shell-unknown';
  // Tokenize on whitespace; first token is the command.
  const tokens = cmd.split(/\s+/);
  const head = tokens[0];

  // Special case: rm -rf (or -fr) is the high-stakes "recursive delete" class
  // regardless of the target path. Policies key on action class, not path.
  if (head === 'rm') {
    const hasRf = tokens.slice(1).some((t) =>
      /^-[a-z]*r[a-z]*f[a-z]*$|^-[a-z]*f[a-z]*r[a-z]*$/i.test(t),
    );
    return hasRf ? 'shell-rm-recursive' : 'shell-rm';
  }

  // git subcommand: include the subcommand in the slug for finer-grained policy.
  if (head === 'git' && tokens[1]) {
    return `shell-git-${kebab(tokens[1])}`;
  }

  return `shell-${kebab(head)}`;
}

function writeSlug(input, prefix = 'write') {
  const path = input?.file_path ?? '';
  if (path.includes('/user-data/memory/')) return `${prefix}-memory-file`;
  if (path.includes('/user-data/ops/state/')) return `${prefix}-state-file`;
  if (path.includes('/user-data/')) return `${prefix}-userdata-file`;
  return `${prefix}-file`;
}

export function classifyAction(call) {
  const name = call?.name ?? '';
  if (!name) return null;
  if (READ_ONLY_TOOLS.has(name)) return null;
  if (name.startsWith('mcp__')) return mcpSlug(name);
  if (name === 'Bash') return bashSlug(call.input);
  if (name === 'Write') return writeSlug(call.input, 'write');
  if (name === 'Edit') return writeSlug(call.input, 'edit');
  if (name === 'NotebookEdit') return writeSlug(call.input, 'edit');
  return kebab(name);
}
