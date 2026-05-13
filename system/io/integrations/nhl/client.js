// NHL public web API. No auth. Endpoints reverse-engineered from nhle.com.
// Base: https://api-web.nhle.com/v1

const API = 'https://api-web.nhle.com/v1';

async function nhlFetch(path, { fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`${API}${path}`, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`nhl ${path} failed: ${r.status}`);
  return await r.json();
}

export async function fetchClubSchedule({ team, fetchFn, signal }) {
  return await nhlFetch(`/club-schedule-season/${encodeURIComponent(team)}/now`, {
    fetchFn,
    signal,
  });
}

// League-wide weekly schedule. Returns `{ games: [...] }` with each game's
// raw shape preserved, so callers reuse the same buildScheduleEvents pipeline
// as the club endpoint. The upstream payload nests games under
// gameWeek[].games — we flatten one level here.
export async function fetchLeagueSchedule({ fetchFn, signal }) {
  const data = await nhlFetch('/schedule/now', { fetchFn, signal });
  const week = Array.isArray(data?.gameWeek) ? data.gameWeek : [];
  const games = [];
  for (const day of week) {
    if (Array.isArray(day?.games)) games.push(...day.games);
  }
  return { games };
}

// NHL gameType: 1=preseason, 2=regular, 3=playoffs, 4=all-star. We treat
// any week containing a playoff game as "playoffs active" — covers the
// April–June window and degrades cleanly outside it.
export function isPlayoffsActive(games) {
  return Array.isArray(games) && games.some((g) => g?.gameType === 3);
}

export async function fetchStandings({ fetchFn, signal }) {
  return await nhlFetch('/standings/now', { fetchFn, signal });
}

function teamAbbrev(side) {
  return side?.abbrev || side?.placeholder || '';
}

function gameStatusLabel(g) {
  const sched = (g.gameScheduleState || 'OK').toUpperCase();
  if (sched === 'PPD') return 'PPD';
  if (sched === 'CNCL') return 'CNCL';
  if (sched === 'SUSP') return 'SUSP';
  const state = (g.gameState || '').toUpperCase();
  if (state === 'LIVE' || state === 'CRIT') return 'LIVE';
  if (state === 'OFF' || state === 'FINAL') return 'FINAL';
  return 'SCHED';
}

function gameDate(g) {
  // gameDate is "YYYY-MM-DD" in local team tz; fall back to startTimeUTC date.
  if (g.gameDate) return g.gameDate;
  if (g.startTimeUTC) return g.startTimeUTC.slice(0, 10);
  return '';
}

function gameScoreString(g) {
  const status = gameStatusLabel(g);
  const home = g.homeTeam || {};
  const away = g.awayTeam || {};
  if (status === 'FINAL') {
    return `${away.score ?? 0}-${home.score ?? 0} FINAL`;
  }
  if (status === 'LIVE') {
    return `${away.score ?? 0}-${home.score ?? 0} LIVE`;
  }
  return status;
}

export function buildScheduleEvents(games, { today = new Date(), windowDays = 14 } = {}) {
  const todayStr = today.toISOString().slice(0, 10);
  const events = [];
  for (const g of Array.isArray(games) ? games : []) {
    const date = gameDate(g);
    if (!date) continue;
    const diffDays = Math.round((Date.parse(date) - Date.parse(todayStr)) / 86_400_000);
    if (diffDays < -windowDays || diffDays > windowDays) continue;
    const home = g.homeTeam || {};
    const away = g.awayTeam || {};
    const homeAbbrev = teamAbbrev(home);
    const awayAbbrev = teamAbbrev(away);
    const gameId = g.id ?? `${date}-${awayAbbrev}-at-${homeAbbrev}`;
    const status = gameStatusLabel(g);
    const result = gameScoreString(g);
    events.push({
      source: 'nhl',
      content: `${awayAbbrev} @ ${homeAbbrev} · ${date} · ${result}`,
      ts: g.startTimeUTC ? new Date(g.startTimeUTC) : new Date(`${date}T00:00:00Z`),
      external_id: `nhl:game:${gameId}`,
      meta: {
        kind: 'game',
        game_id: gameId,
        game_type: g.gameType ?? null,
        away: awayAbbrev,
        home: homeAbbrev,
        date,
        status,
        score:
          status === 'FINAL' || status === 'LIVE'
            ? { away: away.score ?? 0, home: home.score ?? 0 }
            : null,
      },
    });
  }
  return events;
}

export function buildStandingsEvent(standings, { today = new Date() } = {}) {
  const dateStr = today.toISOString().slice(0, 10);
  const rows = Array.isArray(standings?.standings) ? standings.standings : [];
  const divisions = new Map();
  for (const r of rows) {
    const div = r.divisionName ?? r.divisionAbbrev ?? 'Unknown';
    if (!divisions.has(div)) divisions.set(div, []);
    divisions.get(div).push({
      team: teamAbbrev({ abbrev: r.teamAbbrev?.default ?? r.teamAbbrev }),
      points: r.points ?? null,
      gp: r.gamesPlayed ?? null,
      wins: r.wins ?? null,
      losses: r.losses ?? null,
      ot: r.otLosses ?? null,
    });
  }
  const summary = [...divisions.entries()]
    .map(([div, teams]) => {
      const top = teams.sort((a, b) => (b.points ?? 0) - (a.points ?? 0))[0];
      return top ? `${div}: ${top.team} (${top.points}p)` : div;
    })
    .join(' · ');
  return {
    source: 'nhl',
    content: `NHL standings (${dateStr}): ${summary || 'no data'}`,
    ts: today,
    external_id: `nhl:standings:${dateStr}`,
    meta: {
      kind: 'standings',
      date: dateStr,
      divisions: [...divisions.entries()].map(([name, teams]) => ({ name, teams })),
    },
  };
}

export function buildSummaryEvent({ team, games, today = new Date() } = {}) {
  const dateStr = today.toISOString().slice(0, 10);
  const sorted = (Array.isArray(games) ? games : []).slice().sort((a, b) => {
    const ad = gameDate(a);
    const bd = gameDate(b);
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
  let prev = null;
  let next = null;
  for (const g of sorted) {
    const status = gameStatusLabel(g);
    const date = gameDate(g);
    if (!date) continue;
    if (status === 'FINAL' && (date < dateStr || !prev)) {
      if (!prev || date > gameDate(prev)) prev = g;
    } else if (status !== 'FINAL' && date >= dateStr) {
      if (!next || date < gameDate(next)) next = g;
    }
  }
  const last = prev
    ? `${gameScoreString(prev)} ${teamAbbrev(prev.awayTeam)} @ ${teamAbbrev(prev.homeTeam)} (${gameDate(prev)})`
    : 'n/a';
  const nextSummary = next
    ? `${teamAbbrev(next.awayTeam)} @ ${teamAbbrev(next.homeTeam)} on ${gameDate(next)}`
    : 'n/a';
  return {
    source: 'nhl',
    content: `${team}: last ${last}, next ${nextSummary}`,
    ts: today,
    external_id: `nhl:summary:${dateStr}`,
    meta: {
      kind: 'summary',
      team,
      date: dateStr,
      last: prev
        ? {
            game_id: prev.id ?? null,
            date: gameDate(prev),
            away: teamAbbrev(prev.awayTeam),
            home: teamAbbrev(prev.homeTeam),
            score: { away: prev.awayTeam?.score ?? 0, home: prev.homeTeam?.score ?? 0 },
          }
        : null,
      next: next
        ? {
            game_id: next.id ?? null,
            date: gameDate(next),
            away: teamAbbrev(next.awayTeam),
            home: teamAbbrev(next.homeTeam),
          }
        : null,
    },
  };
}
