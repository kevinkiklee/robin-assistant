import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fogNights, scoreSlot, type WttrDay } from './fog.ts';

function hour(
  time: string,
  fields: Partial<{
    tempF: number;
    DewPointF: number;
    humidity: number;
    windspeedMiles: number;
    chanceoffog: number;
  }>,
) {
  return {
    time,
    tempF: fields.tempF?.toString(),
    DewPointF: fields.DewPointF?.toString(),
    humidity: fields.humidity?.toString(),
    windspeedMiles: fields.windspeedMiles?.toString(),
    chanceoffog: fields.chanceoffog?.toString(),
  };
}

test('fog: saturated calm night scores high with a peak window', () => {
  const days: WttrDay[] = [
    {
      date: '2026-06-10',
      hourly: [
        hour('2100', { tempF: 68, DewPointF: 62, humidity: 84, windspeedMiles: 7, chanceoffog: 0 }),
      ],
    },
    {
      date: '2026-06-11',
      hourly: [
        hour('0', { tempF: 64, DewPointF: 62, humidity: 94, windspeedMiles: 4, chanceoffog: 30 }),
        hour('300', { tempF: 62, DewPointF: 61, humidity: 97, windspeedMiles: 2, chanceoffog: 80 }),
        hour('600', { tempF: 61, DewPointF: 60, humidity: 97, windspeedMiles: 3, chanceoffog: 60 }),
      ],
    },
  ];
  const nights = fogNights(days);
  const tonight = nights.find((n) => n.date === '2026-06-10');
  assert.ok(tonight, 'night of 06-10 reported');
  assert.ok(tonight.index >= 7, `expected high index, got ${tonight.index}`);
  assert.ok(tonight.band === 'likely' || tonight.band === 'very likely');
  assert.ok(
    tonight.peak_window?.includes('3am'),
    `peak should cover 3am, got ${tonight.peak_window}`,
  );
  assert.match(tonight.factors ?? '', /spread 1°F/);
});

test('fog: dry windy night scores ~0 and reports no peak', () => {
  const days: WttrDay[] = [
    {
      date: '2026-06-10',
      hourly: [
        hour('2100', {
          tempF: 70,
          DewPointF: 45,
          humidity: 40,
          windspeedMiles: 15,
          chanceoffog: 0,
        }),
      ],
    },
    {
      date: '2026-06-11',
      hourly: [
        hour('0', { tempF: 66, DewPointF: 44, humidity: 45, windspeedMiles: 14, chanceoffog: 0 }),
        hour('300', { tempF: 63, DewPointF: 44, humidity: 50, windspeedMiles: 12, chanceoffog: 0 }),
      ],
    },
  ];
  const [night] = fogNights(days);
  assert.equal(night.index, 0);
  assert.equal(night.band, 'unlikely');
  assert.equal(night.peak_window, null);
});

test('fog: provider chanceoffog floors the score even when composite is low', () => {
  // Advection/post-rain fog the radiation composite would miss.
  const s = scoreSlot(
    hour('300', { tempF: 70, DewPointF: 60, humidity: 75, windspeedMiles: 10, chanceoffog: 90 }),
    '3am',
  );
  assert.ok(s);
  assert.ok(s.score >= 9, `chanceoffog 90 should floor at 9, got ${s.score}`);
});

test('fog: empty slot returns null instead of scoring calm-and-clear', () => {
  assert.equal(scoreSlot({ time: '300' }, '3am'), null);
});

test('fog: a night needs two scorable slots — trailing forecast day is dropped', () => {
  const days: WttrDay[] = [
    {
      date: '2026-06-12',
      hourly: [hour('2100', { tempF: 65, DewPointF: 64, humidity: 97, windspeedMiles: 2 })],
    },
    // No following day → only the 9pm slot exists.
  ];
  assert.equal(fogNights(days).length, 0);
});

test('fog: three forecast days yield two reportable nights, date-keyed', () => {
  const mild = (t: string) =>
    hour(t, { tempF: 70, DewPointF: 60, humidity: 70, windspeedMiles: 8, chanceoffog: 0 });
  const days: WttrDay[] = [
    { date: '2026-06-10', hourly: [mild('2100'), mild('0'), mild('300'), mild('600')] },
    { date: '2026-06-11', hourly: [mild('2100'), mild('0'), mild('300'), mild('600')] },
    { date: '2026-06-12', hourly: [mild('2100'), mild('0'), mild('300'), mild('600')] },
  ];
  const nights = fogNights(days);
  assert.deepEqual(
    nights.map((n) => n.date),
    ['2026-06-10', '2026-06-11'],
  );
});
