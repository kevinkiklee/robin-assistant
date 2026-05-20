import { ingest } from '../../../brain/memory/ingest.ts';
import type { Integration } from '../../_runtime/types.ts';

export const integration: Integration = {
  async tick(ctx) {
    const location = ctx.state.get('location') ?? 'New+York';
    const res = await ctx.fetch(`https://wttr.in/${location}?format=j1`);
    if (!res.ok) {
      return { status: 'error', message: `wttr.in returned ${res.status}` };
    }
    const data = (await res.json()) as {
      current_condition?: Array<{ temp_F?: string; weatherDesc?: Array<{ value: string }> }>;
    };
    const cond = data.current_condition?.[0];
    const summary = `Weather (${location}): ${cond?.temp_F ?? '?'}°F, ${cond?.weatherDesc?.[0]?.value ?? 'unknown'}`;
    await ingest(ctx.db, ctx.llm, {
      kind: 'integration.tick',
      source: 'weather',
      content: summary,
      payload: { location, temp_f: cond?.temp_F, desc: cond?.weatherDesc?.[0]?.value },
    });
    ctx.state.set('last_sync', ctx.now().toISOString());
    return { status: 'ok', ingested: 1 };
  },
  async health(ctx) {
    const last = ctx.state.get('last_sync');
    return { ok: true, message: last ? `last sync: ${last}` : 'never synced' };
  },
};
