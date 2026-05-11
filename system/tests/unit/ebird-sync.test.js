import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { buildEventFromObservation } from '../../io/integrations/ebird/client.js';
import { sync } from '../../io/integrations/ebird/sync.js';

test('buildEventFromObservation shapes content + meta', () => {
  const obs = {
    speciesCode: 'norcar',
    comName: 'Northern Cardinal',
    sciName: 'Cardinalis cardinalis',
    locId: 'L191106',
    locName: 'Central Park',
    obsDt: '2026-05-09 14:30',
    howMany: 2,
    subId: 'S123456789',
    lat: 40.7829,
    lng: -73.9654,
  };
  const e = buildEventFromObservation(obs, 'L191106');
  assert.equal(e.source, 'ebird');
  assert.equal(e.external_id, 'ebird:S123456789');
  assert.match(e.content, /Northern Cardinal/);
  assert.match(e.content, /Central Park/);
  assert.equal(e.meta.species, 'norcar');
  assert.equal(e.meta.count, 2);
  assert.equal(e.meta.location_id, 'L191106');
});

test('ebird sync calls API with token header and captures events', async () => {
  const calls = [];
  const fetchFn = mock.fn(async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    return {
      ok: true,
      json: async () => [
        {
          speciesCode: 'amerob',
          comName: 'American Robin',
          sciName: 'Turdus migratorius',
          locId: 'L191106',
          locName: 'Central Park',
          obsDt: '2026-05-09 09:00',
          howMany: 5,
          subId: 'S111',
        },
        {
          speciesCode: 'norcar',
          comName: 'Northern Cardinal',
          sciName: 'Cardinalis cardinalis',
          locId: 'L191106',
          locName: 'Central Park',
          obsDt: '2026-05-09 10:00',
          howMany: 1,
          subId: 'S222',
        },
      ],
    };
  });
  const captured = [];
  const r = await sync({
    secrets: { EBIRD_API_KEY: 'k' },
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 2);
  assert.equal(captured.length, 2);
  assert.equal(calls[0].headers['X-eBirdApiToken'], 'k');
  assert.match(calls[0].url, /\/data\/obs\/L191106\/recent/);
});
