import { getAccessToken } from '../_auth/token-cache.js';
import {
  buildEventFromCycle,
  buildEventFromRecovery,
  buildEventFromSleep,
  buildEventFromWorkout,
  listCycles,
  listRecovery,
  listSleep,
  listWorkouts,
} from './client.js';

async function paginateAll({ fetcher, accessToken, ctx, builder, since }) {
  const events = [];
  let nextToken = null;
  do {
    const page = await fetcher({
      accessToken,
      since,
      nextToken,
      fetchFn: ctx.fetchFn,
      signal: ctx.signal,
    });
    nextToken = page.next_token ?? null;
    const items = page.records ?? page.data ?? [];
    for (const item of items) events.push(builder(item));
  } while (nextToken);
  return events;
}

export async function sync(ctx) {
  const accessToken = await getAccessToken({
    provider: 'whoop',
    secrets: ctx.secrets,
    fetchFn: ctx.fetchFn,
    saveSecret: ctx.saveSecret,
  });
  const cur = ctx.cursor ?? {};
  const [recovery, sleep, workouts, cycles] = await Promise.all([
    paginateAll({
      fetcher: listRecovery,
      accessToken,
      ctx,
      builder: buildEventFromRecovery,
      since: cur.recovery,
    }),
    paginateAll({
      fetcher: listSleep,
      accessToken,
      ctx,
      builder: buildEventFromSleep,
      since: cur.sleep,
    }),
    paginateAll({
      fetcher: listWorkouts,
      accessToken,
      ctx,
      builder: buildEventFromWorkout,
      since: cur.workout,
    }),
    paginateAll({
      fetcher: listCycles,
      accessToken,
      ctx,
      builder: buildEventFromCycle,
      since: cur.cycle,
    }),
  ]);
  const events = [...recovery, ...sleep, ...workouts, ...cycles];
  await ctx.capture(events);
  const now = new Date().toISOString();
  return {
    count: events.length,
    cursor: { recovery: now, sleep: now, workout: now, cycle: now },
  };
}
