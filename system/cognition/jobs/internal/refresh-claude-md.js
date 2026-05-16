// refresh-claude-md.js — hourly regen of ~/.claude/CLAUDE.md +
// ~/.gemini/GEMINI.md so persona / jobs / integration changes reach agent
// sessions without requiring a manual `robin mcp install`.
//
// Self-improvement loop relies on this: the comm-style synth job updates the
// scalar tone/formality fields nightly, and the long-form `character` /
// `communication-style` / `personality` bodies can be updated by other
// processes (rule promotion, character resynthesis). Until this job ran,
// those updates only appeared in CLAUDE.md when a human reinstalled the MCP.

import { refreshAgentsMdFiles } from '../../../runtime/install/agents-md-refresh.js';

export default async function refreshClaudeMd() {
  const results = await refreshAgentsMdFiles();
  return JSON.stringify(
    Object.fromEntries(results.map((r) => [r.path, r.action])),
  );
}
