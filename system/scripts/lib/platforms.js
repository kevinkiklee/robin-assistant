const POINTER_BASE = `Read and follow AGENTS.md for all instructions (it includes the session-startup protocol — do it).
After every response, scan for capturable signals and write to user-data/memory/streams/inbox.md with tags.

Discovery — never claim an integration or data source is unavailable without first checking:
- \`user-data/runtime/config/integrations.md\` — canonical list of configured integrations
- \`user-data/runtime/scripts/\` — sync/auth/write scripts (e.g., \`sync-lunch-money.js\`)
- \`user-data/runtime/jobs/\` — scheduled syncs
- \`user-data/memory/knowledge/<topic>/\` — already-synced data on disk (often answers the question without an API call)
`;

// Claude Code adds an explicit Local Memory rule + hook context. Claude Code's
// framework auto-memory writes to ~/.claude/projects/<slug>/memory/ unless we
// override; .claude/settings.json wires a PreToolUse hook that blocks those
// writes, and a Stop hook that drains anything that slipped through to inbox.md.
// This pointer also tells the model directly so it doesn't even attempt the bypass.
const CLAUDE_CODE_EXTRAS = `
Claude Code specifics:
- The PreToolUse hook in \`.claude/settings.json\` blocks writes to \`~/.claude/projects/.../memory/\`. Don't try; the rule is enforced at the tool layer. Use \`user-data/memory/streams/inbox.md\` (with a \`[tag]\` line) or the appropriate \`user-data/memory/...\` file.
- The Stop hook drains any auto-memory that slipped through. You don't need to invoke the migrate script manually.
- Skills, MCPs, and CLAUDE.md auto-discovery remain on. \`--bare\` is NOT used.
`;

const POINTER = POINTER_BASE;
const CLAUDE_CODE_POINTER = POINTER_BASE + CLAUDE_CODE_EXTRAS;

// Frontier-only host targets (Phase 2e of the token-optimization design).
// Cursor and Antigravity (v1.20.3+) read AGENTS.md natively as of 2026, so
// no pointer file is generated for them. Codex has always read AGENTS.md
// natively. Claude Code and Gemini CLI need a pointer because their default
// instruction file is CLAUDE.md / GEMINI.md respectively.
export const PLATFORMS = {
  'claude-code': { pointerFile: 'CLAUDE.md', pointerContent: CLAUDE_CODE_POINTER },
  'cursor':      { pointerFile: null, pointerContent: null },
  'gemini-cli':  { pointerFile: 'GEMINI.md', pointerContent: POINTER },
  'codex':       { pointerFile: null, pointerContent: null },
  'antigravity': { pointerFile: null, pointerContent: null },
};
