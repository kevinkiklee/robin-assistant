import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  buildScheduleEvents,
  buildStandingsEvent,
  buildSummaryEvent,
} from '../../io/integrations/nhl/client.js';
import { sync } from '../../io/integrations/nhl/sync.js';

const sampleGames = [
  {
    id: 1,
    gameDate: '2026-05-09',
    startTimeUTC: '2026-05-09T23:00:00Z',
    awayTeam: { abbrev: 'NYR', score: 4 },
    homeTeam: { abbrev: 'BOS', score: 2 },
    gameState: 'OFF',
  },
  {
    id: 2,
    gameDate: '2026-05-12',
    startTimeUTC: '2026-05-12T23:00:00Z',
    awayTeam: { abbrev: 'TOR' },
    homeTeam: { abbrev: 'NYR' },
    gameState: 'FUT',
  },
];

test('buildScheduleEvents emits one event per game in window', () => {
  const today = new Date('2026-05-10T00:00:00Z');
  const events = buildScheduleEvents(sampleGames, { team: 'NYR', today, windowDays: 14 });
  assert.equal(events.length, 2);
  assert.equal(events[0].external_id, 'nhl:game:1');
  assert.match(events[0].content, /NYR @ BOS/);
  assert.match(events[0].content, /4-2 FINAL/);
  assert.equal(events[1].meta.status, 'SCHED');
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
  const events = buildScheduleEvents(future, { team: 'NYR', today, windowDays: 14 });
  assert.equal(events.length, 0);
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

test('nhl sync emits schedule + standings + summary events', async () => {
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/club-schedule-season/'))
      return { ok: true, json: async () => ({ games: sampleGames }) };
    if (url.includes('/standings/now'))
      return {
        ok: true,
        json: async () => ({
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
        }),
      };
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
  // 2 schedule + 1 standings + 1 summary
  assert.equal(r.count, 4);
  assert.equal(captured.filter((e) => e.meta.kind === 'game').length, 2);
  assert.equal(captured.filter((e) => e.meta.kind === 'standings').length, 1);
  assert.equal(captured.filter((e) => e.meta.kind === 'summary').length, 1);
});
