const POINTER = 'Read and follow AGENTS.md for all instructions.\nAfter every response, scan for capturable signals and write to user-data/memory/inbox.md with tags.\n';

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
