import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  buildScheduleEvents,
  buildStandingsEvent,
  buildSummaryEvent,
  isPlayoffsActive,
} from '../../io/integrations/nhl/client.js';
import { sync } from '../../io/integrations/nhl/sync.js';

const sampleGames = [
  {
    id: 1,
    gameType: 2,
    gameDate: '2026-05-09',
    startTimeUTC: '2026-05-09T23:00:00Z',
    awayTeam: { abbrev: 'NYR', score: 4 },
    homeTeam: { abbrev: 'BOS', score: 2 },
    gameState: 'OFF',
  },
  {
    id: 2,
    gameType: 2,
    gameDate: '2026-05-12',
    startTimeUTC: '2026-05-12T23:00:00Z',
    awayTeam: { abbrev: 'TOR' },
    homeTeam: { abbrev: 'NYR' },
    gameState: 'FUT',
  },
];

test('buildScheduleEvents emits one event per game in window', () => {
  const today = new Date('2026-05-10T00:00:00Z');
  const events = buildScheduleEvents(sampleGames, { today, windowDays: 14 });
  assert.equal(events.length, 2);
  assert.equal(events[0].external_id, 'nhl:game:1');
  assert.match(events[0].content, /NYR @ BOS/);
  assert.match(events[0].content, /4-2 FINAL/);
  assert.equal(events[1].meta.status, 'SCHED');
  assert.equal(events[0].meta.game_type, 2);
});

test('buildScheduleEvents drops games outside ±windowDays', () => {
  const today = new Date('2026-05-10T00:00:00Z');
  const future = [
    {
      id: 9,
      gameDate: '2026-09-01',
      startTimeUTC: '2026-09-01T23:00:00Z',
      awayTeam: { abbrev: 'NYR' },
      homeTeam: { abbrev: 'BUF' },
      gameState: 'FUT',
    },
  ];
  const events = buildScheduleEvents(future, { today, windowDays: 14 });
  assert.equal(events.length, 0);
});

test('isPlayoffsActive flips on any gameType=3 in week', () => {
  assert.equal(isPlayoffsActive(sampleGames), false);
  assert.equal(isPlayoffsActive([...sampleGames, { gameType: 3 }]), true);
  assert.equal(isPlayoffsActive([]), false);
  assert.equal(isPlayoffsActive(null), false);
});

test('buildStandingsEvent rolls divisions up', () => {
  const standings = {
    standings: [
      {
        divisionName: 'Metropolitan',
        teamAbbrev: { default: 'NYR' },
        points: 100,
        gamesPlayed: 70,
        wins: 45,
        losses: 20,
        otLosses: 5,
      },
      {
        divisionName: 'Metropolitan',
        teamAbbrev: { default: 'CAR' },
        points: 95,
        gamesPlayed: 70,
        wins: 42,
        losses: 22,
        otLosses: 6,
      },
    ],
  };
  const today = new Date('2026-05-10T00:00:00Z');
  const e = buildStandingsEvent(standings, { today });
  assert.equal(e.external_id, 'nhl:standings:2026-05-10');
  assert.match(e.content, /Metropolitan/);
  assert.equal(e.meta.divisions[0].teams.length, 2);
});

test('buildSummaryEvent picks last final + next scheduled', () => {
  const today = new Date('2026-05-10T00:00:00Z');
  const e = buildSummaryEvent({ team: 'NYR', games: sampleGames, today });
  assert.equal(e.external_id, 'nhl:summary:2026-05-10');
  assert.match(e.content, /NYR/);
  assert.equal(e.meta.last.date, '2026-05-09');
  assert.equal(e.meta.next.date, '2026-05-12');
});

// Wraps the per-day shape /schedule/now returns. Mirrors the real upstream
// payload so the flattening in fetchLeagueSchedule is exercised.
function leagueWeek(games) {
  return {
    gameWeek: [
      { date: '2026-05-09', games: games.filter((g) => g.gameDate === '2026-05-09') },
      { date: '2026-05-12', games: games.filter((g) => g.gameDate === '2026-05-12') },
    ],
  };
}

const standingsPayload = {
  standings: [
    {
      divisionName: 'Metropolitan',
      teamAbbrev: { default: 'NYR' },
      points: 100,
      gamesPlayed: 70,
      wins: 45,
      losses: 20,
      otLosses: 5,
    },
  ],
};

test('nhl sync (regular season) filters to favorite team + emits summary', async () => {
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/schedule/now'))
      return { ok: true, json: async () => leagueWeek(sampleGames) };
    if (url.includes('/standings/now')) return { ok: true, json: async () => standingsPayload };
    throw new Error(`unexpected ${url}`);
  });
  const captured = [];
  const r = await sync({
    secrets: {},
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  // Both sample games involve NYR, so the team filter keeps both.
  assert.equal(r.count, 4);
  assert.equal(r.cursor.phase, 'regular');
  assert.equal(captured.filter((e) => e.meta.kind === 'game').length, 2);
  assert.equal(captured.filter((e) => e.meta.kind === 'standings').length, 1);
  assert.equal(captured.filter((e) => e.meta.kind === 'summary').length, 1);
});

test('nhl sync (regular season) drops games not involving favorite team', async () => {
  const otherGame = {
    id: 7,
    gameType: 2,
    gameDate: '2026-05-12',
    startTimeUTC: '2026-05-12T23:00:00Z',
    awayTeam: { abbrev: 'BUF' },
    homeTeam: { abbrev: 'MTL' },
    gameState: 'FUT',
  };
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/schedule/now'))
      return { ok: true, json: async () => leagueWeek([...sampleGames, otherGame]) };
    if (url.includes('/standings/now')) return { ok: true, json: async () => standingsPayload };
    throw new Error(`unexpected ${url}`);
  });
  const captured = [];
  await sync({
    secrets: {},
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  const ids = captured.filter((e) => e.meta.kind === 'game').map((e) => e.external_id);
  assert.deepEqual(ids.sort(), ['nhl:game:1', 'nhl:game:2']);
});

test('nhl sync (playoffs) keeps all games, skips single-team summary', async () => {
  const playoffGames = [
    {
      id: 'p1',
      gameType: 3,
      gameDate: '2026-05-12',
      startTimeUTC: '2026-05-12T23:00:00Z',
      awayTeam: { abbrev: 'BUF' },
      homeTeam: { abbrev: 'MTL' },
      gameState: 'FUT',
    },
    {
      id: 'p2',
      gameType: 3,
      gameDate: '2026-05-12',
      startTimeUTC: '2026-05-13T01:30:00Z',
      awayTeam: { abbrev: 'ANA' },
      homeTeam: { abbrev: 'VGK' },
      gameState: 'FUT',
    },
  ];
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/schedule/now'))
      return { ok: true, json: async () => leagueWeek(playoffGames) };
    if (url.includes('/standings/now')) return { ok: true, json: async () => standingsPayload };
    throw new Error(`unexpected ${url}`);
  });
  const captured = [];
  const r = await sync({
    secrets: {},
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.cursor.phase, 'playoffs');
  assert.equal(captured.filter((e) => e.meta.kind === 'game').length, 2);
  assert.equal(captured.filter((e) => e.meta.kind === 'summary').length, 0);
  assert.equal(captured.filter((e) => e.meta.kind === 'standings').length, 1);
});
