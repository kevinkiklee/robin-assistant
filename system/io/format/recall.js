// Trim recall results to a snippet budget for agent-facing display.
// Keep up to N events at full length until the cumulative size hits
// `snippetBudgetChars`. For events beyond that, truncate to
// `snippetPerEventMax` chars with a trailing ellipsis.
//
// Defaults: 5 events at full, then 4000-char cumulative budget,
// then 200-char per-event truncation. Agent can override via args.

const DEFAULT_FULL_EVENTS = 5;
const DEFAULT_BUDGET = 4000;
const DEFAULT_PER_EVENT_MAX = 200;

export function trimRecallEvents(events, opts = {}) {
  const fullN = opts.fullEvents ?? DEFAULT_FULL_EVENTS;
  const budget = opts.snippetBudgetChars ?? DEFAULT_BUDGET;
  const perEventMax = opts.snippetPerEventMax ?? DEFAULT_PER_EVENT_MAX;

  const out = [];
  let used = 0;
  let fullKept = 0;

  for (const e of events) {
    const text = e.content ?? '';
    if (fullKept < fullN && used + text.length <= budget) {
      out.push({ ...e, content: text, truncated: false });
      used += text.length;
      fullKept += 1;
    } else if (text.length <= perEventMax) {
      out.push({ ...e, content: text, truncated: false });
    } else {
      out.push({ ...e, content: `${text.slice(0, perEventMax)}…`, truncated: true });
    }
  }
  return out;
}
