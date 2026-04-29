const POINTER = `Read and follow AGENTS.md for all instructions (it includes the session-startup protocol — do it).
After every response, scan for capturable signals and write to user-data/memory/inbox.md with tags.

Discovery — never claim an integration or data source is unavailable without first checking:
- \`user-data/integrations.md\` — canonical list of configured integrations
- \`user-data/scripts/\` — sync/auth/write scripts (e.g., \`sync-lunch-money.js\`)
- \`user-data/jobs/\` — scheduled syncs
- \`user-data/memory/knowledge/<topic>/\` — already-synced data on disk (often answers the question without an API call)
`;

// Frontier-only host targets (Phase 2e of the token-optimization design).
// Cursor and Antigravity (v1.20.3+) read AGENTS.md natively as of 2026, so
// no pointer file is generated for them. Codex has always read AGENTS.md
// natively. Claude Code and Gemini CLI need a pointer because their default
// instruction file is CLAUDE.md / GEMINI.md respectively.
export const PLATFORMS = {
  'claude-code': { pointerFile: 'CLAUDE.md', pointerContent: POINTER },
  'cursor':      { pointerFile: null, pointerContent: null },
  'gemini-cli':  { pointerFile: 'GEMINI.md', pointerContent: POINTER },
  'codex':       { pointerFile: null, pointerContent: null },
  'antigravity': { pointerFile: null, pointerContent: null },
};
