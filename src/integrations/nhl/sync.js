import {
  buildScheduleEvents,
  buildStandingsEvent,
  buildSummaryEvent,
  fetchClubSchedule,
  fetchStandings,
} from './client.js';

const DEFAULT_TEAM = 'NYR';

export async function sync(ctx) {
  const team = process.env.NHL_TEAM || DEFAULT_TEAM;
  const today = new Date();

  // Each fetch fails soft so a partial outage still ships the rest. The
  // schedule endpoint is the most useful so we surface its error if all three
  // fail; otherwise we just log and move on.
  const log = ctx.log ?? (() => {});
  const schedule = await fetchClubSchedule({
    team,
    fetchFn: ctx.fetchFn,
    signal: ctx.signal,
  }).catch((e) => {
    log(`schedule failed: ${e.message}`);
    return null;
  });
  const standings = await fetchStandings({ fetchFn: ctx.fetchFn, signal: ctx.signal }).catch(
    (e) => {
      log(`standings failed: ${e.message}`);
      return null;
    },
  );

  const events = [];
  const games = schedule?.games ?? [];
  events.push(...buildScheduleEvents(games, { team, today }));
  if (standings) events.push(buildStandingsEvent(standings, { today }));
  if (games.length > 0) events.push(buildSummaryEvent({ team, games, today }));

  await ctx.capture(events);
  return { count: events.length, cursor: { last_run_at: today.toISOString() } };
}
