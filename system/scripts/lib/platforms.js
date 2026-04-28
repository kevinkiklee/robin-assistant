const POINTER = 'Read and follow AGENTS.md for all instructions.\nAfter every response, scan for capturable signals and write to user-data/inbox.md with tags.\n';

export const PLATFORMS = {
  'claude-code': { pointerFile: 'CLAUDE.md', pointerContent: POINTER },
  'cursor': { pointerFile: '.cursorrules', pointerContent: POINTER },
  'gemini-cli': { pointerFile: 'GEMINI.md', pointerContent: POINTER },
  'codex': { pointerFile: null, pointerContent: null },
  'windsurf': { pointerFile: '.windsurfrules', pointerContent: POINTER },
  'antigravity': { pointerFile: null, pointerContent: null },
};
