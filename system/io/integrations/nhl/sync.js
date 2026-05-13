import {
  buildScheduleEvents,
  buildStandingsEvent,
  buildSummaryEvent,
  fetchLeagueSchedule,
  fetchStandings,
  isPlayoffsActive,
} from './client.js';

const DEFAULT_TEAM = 'NYR';

function teamAbbrev(side) {
  return side?.abbrev || side?.placeholder || '';
}

function gameInvolvesTeam(game, team) {
  return teamAbbrev(game.awayTeam) === team || teamAbbrev(game.homeTeam) === team;
}

export async function sync(ctx) {
  const team = process.env.NHL_TEAM || DEFAULT_TEAM;
  const today = new Date();

  // Each fetch fails soft so a partial outage still ships the rest. The
  // schedule endpoint is the most useful so we surface its error if all three
  // fail; otherwise we just log and move on.
  const log = ctx.log ?? (() => {});
  const schedule = await fetchLeagueSchedule({
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

  // Phase-aware capture: in the playoffs every game is interesting, so we
  // ship the whole league week. Outside playoffs we drop down to just the
  // favorite team so the brief doesn't drown in 16 regular-season fixtures.
  const allGames = schedule?.games ?? [];
  const playoffs = isPlayoffsActive(allGames);
  const games = playoffs ? allGames : allGames.filter((g) => gameInvolvesTeam(g, team));

  const events = [];
  events.push(...buildScheduleEvents(games, { today }));
  if (standings) events.push(buildStandingsEvent(standings, { today }));
  // Summary is a single-team frame; only meaningful when filtered to one
  // team. Skip during playoffs where the multi-team view is the point.
  if (!playoffs && games.length > 0) events.push(buildSummaryEvent({ team, games, today }));

  await ctx.capture(events);
  return {
    count: events.length,
    cursor: { last_run_at: today.toISOString(), phase: playoffs ? 'playoffs' : 'regular' },
  };
}
