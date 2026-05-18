// AskUserQuestion is invisible under Discord (no terminal UI). Convert
// the structured question/options shape into a numbered-text rendering
// the agent can include in its plain reply.
//
// `isDiscordSession()` lets call-sites branch on the spawning platform —
// the Discord bot agent spawner sets `ROBIN_SESSION_PLATFORM=discord` so
// downstream code can swap interactive widgets for plain text.

export function renderAskAsText({ question, options }) {
  const lines = [question];
  options.forEach((opt, i) => {
    const num = i + 1;
    const label = typeof opt === 'string' ? opt : opt.label;
    const desc = typeof opt === 'object' && opt.description ? ` — ${opt.description}` : '';
    lines.push(`${num}. ${label}${desc}`);
  });
  return lines.join('\n');
}

export function isDiscordSession() {
  return process.env.ROBIN_SESSION_PLATFORM === 'discord';
}
