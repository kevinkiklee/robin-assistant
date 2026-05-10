import { buildEventFromIssue, listActiveIssues } from './client.js';

function parseTeams(raw) {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function sync(ctx) {
  const updatedAfter = ctx.cursor?.updated_after ?? null;
  const teamKeys = parseTeams(process.env.LINEAR_TEAMS);
  const issues = await listActiveIssues({
    apiKey: ctx.secrets.LINEAR_API_KEY,
    updatedAfter,
    teamKeys,
    cap: 200,
    fetchFn: ctx.fetchFn,
    signal: ctx.signal,
  });
  const events = issues.map(buildEventFromIssue);
  await ctx.capture(events);
  // Forward cursor to the most recent updatedAt we saw, fall back to now.
  const maxUpdated = issues.reduce((acc, i) => {
    if (!i.updatedAt) return acc;
    return acc && acc > i.updatedAt ? acc : i.updatedAt;
  }, null);
  return {
    count: events.length,
    cursor: { updated_after: maxUpdated ?? new Date().toISOString() },
  };
}
