import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import type { RunSdkInput, SdkResult } from '../sdk.ts';
import { type ChainDeps, type ChainResult, runSdkWithCredentials } from './chain.ts';
import { fingerprint } from './config.ts';
import type { CallClass } from './select.ts';
import { type ChainState, type CredentialState, type LimitState, statePath } from './state.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ROBIN = 'sk-ant-oat01-FAKE-robin';
const SHARED = 'sk-ant-oat01-FAKE-shared';
const CREDIT = 'sk-ant-api03-FAKE-credit';
const ENV = {
  CLAUDE_TOKEN_ROBIN: ROBIN,
  CLAUDE_TOKEN_SHARED: SHARED,
  CLAUDE_CREDIT_KEY_ROBIN: CREDIT,
};
const SECRET_OF: Record<string, string> = {
  'robin:subscription': ROBIN,
  'shared:subscription': SHARED,
  'robin:credit': CREDIT,
};

const INPUT: RunSdkInput = { prompt: 'hello', model: 'claude-sonnet-5-5', maxTurns: 4 };

function ok(over: Partial<SdkResult> = {}): SdkResult {
  return {
    status: 'success',
    text: 'done',
    turns: 1,
    costUsd: 0.01,
    usage: { inputTokens: 10, outputTokens: 5 },
    raw: null,
    limitHit: false,
    ...over,
  };
}

function limited(over: Partial<SdkResult> = {}): SdkResult {
  return ok({
    status: 'error',
    text: '',
    costUsd: 0,
    limitHit: true,
    rateLimit: { status: 'rejected', resetsAtMs: NOW + 2 * HOUR, type: 'five_hour' },
    ...over,
  });
}

function cs(
  id: string,
  limits: Array<Partial<LimitState>> = [],
  extra: Partial<CredentialState> = {},
) {
  return {
    fingerprint: fingerprint(SECRET_OF[id]),
    firstSeenAtMs: NOW - DAY,
    limits: limits.map((l) => ({
      status: 'rejected' as const,
      scope: 'all' as const,
      observedAtMs: NOW - MIN,
      ...l,
    })),
    ...extra,
  };
}

interface Notice {
  title: string;
  message: string;
  silent?: boolean;
}

function setup(
  o: {
    env?: Record<string, string | undefined>;
    seed?: ChainState['credentials'];
    mode?: 'auto' | 'manual';
    userData?: string;
    runSdk?: ChainDeps['runSdk'];
  } = {},
) {
  const dir = o.userData ?? mkdtempSync(join(tmpdir(), 'robin-chain-'));
  const clock = { t: NOW };
  const calls: RunSdkInput[] = [];
  const notices: Notice[] = [];
  const queue: SdkResult[] = [];
  if (o.seed) {
    mkdirSync(dirname(statePath(dir)), { recursive: true });
    writeFileSync(statePath(dir), JSON.stringify({ version: 1, credentials: o.seed }));
  }
  const deps: ChainDeps = {
    env: o.env ?? ENV,
    userData: () => dir,
    mode: () => o.mode ?? 'auto',
    now: () => clock.t,
    notify: async (p) => {
      notices.push(p);
      return { delivered: true };
    },
    runSdk:
      o.runSdk ??
      (async (i) => {
        calls.push(i);
        return queue.shift() ?? ok();
      }),
  };
  const state = (): ChainState => JSON.parse(readFileSync(statePath(dir), 'utf8'));
  const secretOf = (i: RunSdkInput) =>
    i.credentialEnv?.set.CLAUDE_CODE_OAUTH_TOKEN ?? i.credentialEnv?.set.ANTHROPIC_API_KEY;
  const call = (cls: CallClass, input: RunSdkInput = INPUT, opts?: { emptyIsLimit?: boolean }) =>
    runSdkWithCredentials(input, cls, deps, opts);
  return { dir, clock, calls, notices, queue, deps, state, secretOf, call };
}

describe('runSdkWithCredentials', () => {
  it('ambient when no credentials configured', async () => {
    const calls: RunSdkInput[] = [];
    const input: RunSdkInput = { prompt: 'p', model: 'm', billToPool: true };
    const res = await runSdkWithCredentials(input, 'background', {
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE-ambient' },
      userData: () => {
        throw new Error('userData must not be resolved');
      },
      mode: () => {
        throw new Error('mode must not be read');
      },
      runSdk: async (i) => {
        calls.push(i);
        return ok();
      },
    });
    assert.equal(calls.length, 1);
    assert.deepStrictEqual(calls[0], { prompt: 'p', model: 'm', billToPool: true });
    assert.equal('credentialEnv' in calls[0], false);
    assert.deepStrictEqual(res, ok());
  });

  it('ambient leaves no state file', async () => {
    const h = setup({ env: {} });
    await h.call('interactive');
    assert.equal(existsSync(statePath(h.dir)), false);
    assert.equal(h.calls.length, 1);
  });

  it('uses robin first', async () => {
    const h = setup();
    const res = await h.call('interactive');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].credentialEnv?.set.CLAUDE_CODE_OAUTH_TOKEN, ROBIN);
    assert.deepEqual(h.calls[0].credentialEnv?.unset, ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY']);
    assert.equal(res.credential, 'robin:subscription');
    assert.equal(res.text, 'done');
    const s = h.state().credentials['robin:subscription'];
    assert.equal(s.firstSeenAtMs, NOW);
    assert.equal(s.lastUsedAtMs, NOW);
    assert.equal(s.fingerprint, fingerprint(ROBIN));
  });

  it('retries shared after first-turn limit', async () => {
    const h = setup();
    h.queue.push(limited({ turns: 1, costUsd: 0.002, usage: { inputTokens: 3, outputTokens: 0 } }));
    const res = await h.call('interactive');
    assert.equal(h.calls.length, 2);
    assert.equal(h.secretOf(h.calls[0]), ROBIN);
    assert.equal(h.secretOf(h.calls[1]), SHARED);
    assert.equal(res.credential, 'shared:subscription');
    assert.equal(res.text, 'done');
    // the failed attempt's spend is not lost
    assert.equal(res.costUsd, 0.012);
    assert.equal(res.usage.inputTokens, 13);
    const robin = h.state().credentials['robin:subscription'];
    assert.equal(robin.limits[0].status, 'rejected');
    assert.equal(robin.limits[0].resetsAtMs, NOW + 2 * HOUR);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].silent, true);
    assert.match(
      h.notices[0].message,
      /^Robin is borrowing your Claude account \(robin limit, resets .+\)$/,
    );
    // deduped: the next call goes straight to shared without a second notice
    await h.call('interactive');
    assert.equal(h.secretOf(h.calls[2]), SHARED);
    assert.equal(h.notices.length, 1);
  });

  it('no retry after turns > 1', async () => {
    const h = setup();
    const r = limited({ turns: 3 });
    h.queue.push(r);
    const res = await h.call('interactive');
    assert.equal(h.calls.length, 1);
    assert.deepStrictEqual(res, { ...r, credential: 'robin:subscription' });
    assert.equal(h.state().credentials['robin:subscription'].limits[0].status, 'rejected');
  });

  it('no retry on a structured completion that reads as limited', async () => {
    const h = setup();
    h.queue.push(limited({ status: 'success', structured: { a: 1 }, turns: 1 }));
    const res = await h.call('interactive');
    assert.equal(h.calls.length, 1);
    assert.equal(res.credential, 'robin:subscription');
  });

  it('background defers on warning', async () => {
    const h = setup({
      seed: { 'robin:subscription': cs('robin:subscription', [{ status: 'allowed_warning' }]) },
    });
    const res = await h.call('background');
    assert.equal(h.calls.length, 0);
    assert.equal(res.deferred, true);
    assert.equal(res.status, 'error');
    assert.equal(res.limitHit, true);
    assert.match(res.text, /^quota deferred: /);
    assert.equal(res.costUsd, 0);
    assert.deepEqual(res.usage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(h.notices.length, 0);
  });

  it('interactive stop notifies', async () => {
    const lim = [{ resetsAtMs: NOW + HOUR }];
    const h = setup({
      seed: {
        'robin:subscription': cs('robin:subscription', lim),
        'shared:subscription': cs('shared:subscription', lim),
        'robin:credit': cs('robin:credit', lim),
      },
    });
    const res = await h.call('interactive');
    assert.equal(h.calls.length, 0);
    assert.equal(res.stopped, true);
    assert.match(res.text, /^quota exhausted: /);
    assert.equal(h.notices.length, 1);
    assert.notEqual(h.notices[0].silent, true);
    assert.match(h.notices[0].message, /^All Claude credentials are limited until .+/);
    await h.call('interactive');
    assert.equal(h.notices.length, 1, 'stop notice deduped');
  });

  it('stop after every credential failed this call names the reset', async () => {
    const h = setup();
    h.queue.push(
      limited(),
      limited(),
      limited({ rateLimit: undefined, text: "You've hit your limit" }),
    );
    const res = await h.call('interactive');
    assert.equal(h.calls.length, 3);
    assert.equal(res.stopped, true);
    assert.match(res.text, /^quota exhausted: credentials at or near limit/);
    const stop = h.notices.filter((n) => !n.silent);
    assert.equal(stop.length, 1);
    assert.match(stop[0].message, /^All Claude credentials are limited until /);
  });

  it('advancing to a credit key notices once', async () => {
    const lim = [{ resetsAtMs: NOW + HOUR }];
    const h = setup({
      seed: {
        'robin:subscription': cs('robin:subscription', lim),
        'shared:subscription': cs('shared:subscription', lim),
      },
    });
    const res = await h.call('interactive');
    assert.equal(res.credential, 'robin:credit');
    assert.equal(h.secretOf(h.calls[0]), CREDIT);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].silent, true);
    assert.match(
      h.notices[0].message,
      /^Robin is using API credit \(both subscriptions limited, resets .+\)$/,
    );
    await h.call('interactive');
    assert.equal(h.notices.length, 1);
  });

  it('returns to robin after reset', async () => {
    const h = setup({
      seed: {
        'robin:subscription': cs('robin:subscription', [{ resetsAtMs: NOW - 1 }], {
          lastLimitNoticeAtMs: NOW - HOUR,
        }),
      },
    });
    const res = await h.call('background');
    assert.equal(res.credential, 'robin:subscription');
    assert.equal(h.secretOf(h.calls[0]), ROBIN);
    assert.deepEqual(h.state().credentials['robin:subscription'].limits, []);
  });

  it('allowed clears scope', async () => {
    const h = setup({
      seed: { 'robin:subscription': cs('robin:subscription', [{ status: 'allowed_warning' }]) },
    });
    h.queue.push(ok({ rateLimit: { status: 'allowed', type: 'five_hour' } }));
    const res = await h.call('interactive');
    assert.equal(res.credential, 'robin:subscription');
    assert.deepEqual(h.state().credentials['robin:subscription'].limits, []);
  });

  it('records utilization from a rate_limit_event', async () => {
    const h = setup();
    h.queue.push(
      ok({
        rateLimit: {
          status: 'allowed_warning',
          type: 'seven_day_opus',
          utilization: 0.9,
          resetsAtMs: NOW + DAY,
        },
      }),
    );
    await h.call('interactive');
    assert.deepEqual(h.state().credentials['robin:subscription'].limits, [
      {
        status: 'allowed_warning',
        scope: 'opus',
        resetsAtMs: NOW + DAY,
        observedAtMs: NOW,
        type: 'seven_day_opus',
        utilization: 0.9,
      },
    ]);
  });

  it('auth error benches credential', async () => {
    const h = setup();
    h.queue.push(ok({ status: 'error', text: '', authError: 'authentication_failed', turns: 1 }));
    const res = await h.call('interactive');
    assert.equal(h.calls.length, 2);
    assert.equal(h.secretOf(h.calls[1]), SHARED);
    assert.equal(res.credential, 'shared:subscription');
    const robin = h.state().credentials['robin:subscription'];
    assert.equal(robin.limits.length, 1);
    assert.equal(robin.limits[0].status, 'rejected');
    assert.equal(robin.limits[0].scope, 'all');
    assert.equal(robin.limits[0].reason, 'auth');
    assert.ok(Math.abs((robin.limits[0].resetsAtMs ?? 0) - (NOW + 6 * HOUR)) < 1000);
    assert.equal(h.notices.length, 1, 'no borrow notice on top of the auth notice');
    assert.notEqual(h.notices[0].silent, true);
    assert.match(
      h.notices[0].message,
      /^Claude robin \(subscription, [0-9a-f]{12}\) was refused \(authentication_failed\) — run claude setup-token for that account and update daemon\.env$/,
    );
  });

  it('auth error on background never borrows', async () => {
    const h = setup();
    h.queue.push(ok({ status: 'error', text: '', authError: 'authentication_failed', turns: 0 }));
    const res = await h.call('background');
    assert.equal(h.calls.length, 1);
    assert.equal(res.deferred, true);
    assert.match(res.text, /^quota deferred: credential token refused/);
  });

  it('one soft signal changes nothing', async () => {
    const h = setup();
    const empty = ok({ text: '' });
    h.queue.push(empty);
    const res = await h.call('background', INPUT, { emptyIsLimit: true });
    assert.equal(h.calls.length, 1);
    assert.deepStrictEqual(res, { ...empty, credential: 'robin:subscription' });
    const robin = h.state().credentials['robin:subscription'];
    assert.deepEqual(robin.limits, []);
    assert.deepEqual(robin.softHitsAtMs, [NOW]);
    h.clock.t += MIN;
    await h.call('background', INPUT, { emptyIsLimit: true });
    assert.equal(h.secretOf(h.calls[1]), ROBIN);
    assert.equal(h.notices.length, 0);
  });

  it('a bare 429 is a soft signal: no retry', async () => {
    const h = setup();
    h.queue.push(limited({ rateLimit: undefined, text: 'API Error: 429' }));
    const res = await h.call('interactive');
    assert.equal(h.calls.length, 1);
    assert.equal(res.limitHit, true);
    assert.equal(res.credential, 'robin:subscription');
    assert.deepEqual(h.state().credentials['robin:subscription'].limits, []);
  });

  it('empty completion is not a signal without emptyIsLimit', async () => {
    const h = setup();
    h.queue.push(ok({ text: '' }));
    await h.call('background');
    assert.equal(h.state().credentials['robin:subscription'].softHitsAtMs, undefined);
  });

  it('three soft signals warn, never borrow', async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) {
      h.queue.push(ok({ text: '' }));
      const r = await h.call('background', INPUT, { emptyIsLimit: true });
      assert.equal(r.credential, 'robin:subscription');
      h.clock.t += MIN;
    }
    assert.equal(h.calls.length, 3);
    const robin = h.state().credentials['robin:subscription'];
    assert.equal(robin.limits.length, 1);
    assert.equal(robin.limits[0].status, 'allowed_warning');
    assert.equal(robin.limits[0].scope, 'all');
    const deferred = await h.call('background');
    assert.equal(deferred.deferred, true);
    assert.equal(h.calls.length, 3, 'no call on shared');
    // 11 min after the first hit it is pruned; two remain → robin probed again
    h.clock.t = NOW + 11 * MIN;
    const again = await h.call('background');
    assert.equal(again.credential, 'robin:subscription');
    assert.equal(h.secretOf(h.calls[3]), ROBIN);
    const after = h.state().credentials['robin:subscription'];
    assert.deepEqual(after.limits, []);
    assert.deepEqual(after.softHitsAtMs, [NOW + MIN, NOW + 2 * MIN]);
    assert.equal(
      h.calls.some((c) => h.secretOf(c) === SHARED),
      false,
    );
  });

  it('banner scope parsed', async () => {
    const h = setup();
    h.queue.push(
      limited({
        rateLimit: undefined,
        text: "You've hit your Sonnet limit · resets 3pm",
        turns: 1,
      }),
    );
    await h.call('interactive', { prompt: 'p' });
    const l = h.state().credentials['robin:subscription'].limits;
    assert.equal(l.length, 1);
    assert.equal(l[0].status, 'rejected');
    assert.equal(l[0].scope, 'sonnet');
    assert.equal(l[0].resetsAtMs, undefined);
    // model is passed to selection: a sonnet call skips robin, an opus call uses it
    const n = h.calls.length;
    await h.call('interactive', { prompt: 'p', model: 'claude-sonnet-5-5' });
    assert.equal(h.secretOf(h.calls[n]), SHARED);
    await h.call('interactive', { prompt: 'p', model: 'claude-opus-5-5' });
    assert.equal(h.secretOf(h.calls[n + 1]), ROBIN);
  });

  it('banner without a model name is scope all', async () => {
    const h = setup();
    h.queue.push(limited({ rateLimit: undefined, text: "You've hit your weekly limit", turns: 1 }));
    await h.call('interactive');
    assert.equal(h.state().credentials['robin:subscription'].limits[0].scope, 'all');
  });

  it('manual mode limit notifies, never advances', async () => {
    const h = setup({ mode: 'manual' });
    h.queue.push(limited({ turns: 1 }));
    const res = await h.call('interactive');
    assert.equal(h.calls.length, 1);
    assert.equal(res.stopped, true);
    assert.equal(h.notices.length, 1);
    assert.notEqual(h.notices[0].silent, true);
    assert.equal(
      h.notices[0].message,
      "Robin's Claude account hit its limit. Switch with: robin accounts use shared",
    );
    await h.call('interactive');
    assert.equal(h.notices.length, 1);
  });

  it('expiry notice once per week', async () => {
    const h = setup({
      seed: {
        'robin:subscription': cs('robin:subscription', [], { firstSeenAtMs: NOW - 340 * DAY }),
      },
    });
    await h.call('background');
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].silent, true);
    assert.equal(
      h.notices[0].message,
      'Claude token for robin expires in 25 days — run claude setup-token and update daemon.env',
    );
    h.clock.t += HOUR;
    await h.call('background');
    assert.equal(h.notices.length, 1);
    h.clock.t = NOW + 8 * DAY;
    await h.call('background');
    assert.equal(h.notices.length, 2);
  });

  it('a rotated token is a new credential', async () => {
    const h = setup({
      seed: {
        'robin:subscription': {
          ...cs('robin:subscription', [{ reason: 'auth', resetsAtMs: NOW + HOUR }]),
          fingerprint: 'aaaaaaaaaaaa',
          firstSeenAtMs: NOW - 360 * DAY,
        },
      },
    });
    const res = await h.call('background');
    assert.equal(res.credential, 'robin:subscription');
    const robin = h.state().credentials['robin:subscription'];
    assert.equal(robin.fingerprint, fingerprint(ROBIN));
    assert.equal(robin.firstSeenAtMs, NOW);
    assert.deepEqual(robin.limits, []);
    assert.equal(h.notices.length, 0);
  });

  it('never leaks a secret', async () => {
    const results: ChainResult[] = [];
    const notices: Notice[] = [];
    const files: string[] = [];
    const run = async (
      h: ReturnType<typeof setup>,
      cls: CallClass,
      opts?: { emptyIsLimit?: boolean },
    ) => {
      results.push(await h.call(cls, INPUT, opts));
    };
    // advance robin → shared → credit, then stop
    const a = setup();
    a.queue.push(limited(), limited());
    await run(a, 'interactive');
    a.queue.push(limited());
    await run(a, 'interactive');
    await run(a, 'interactive');
    // defer
    const b = setup({
      seed: { 'robin:subscription': cs('robin:subscription', [{ status: 'allowed_warning' }]) },
    });
    await run(b, 'background');
    // auth + expiry + soft
    const c = setup({
      seed: {
        'shared:subscription': cs('shared:subscription', [], { firstSeenAtMs: NOW - 350 * DAY }),
      },
    });
    c.queue.push(ok({ status: 'error', text: '', authError: 'billing_error', turns: 0 }));
    await run(c, 'interactive');
    c.queue.push(ok({ text: '' }));
    await run(c, 'brief', { emptyIsLimit: true });
    for (const h of [a, b, c]) {
      notices.push(...h.notices);
      files.push(readFileSync(statePath(h.dir), 'utf8'));
    }
    // a throwing runSdk propagates its own error untouched
    const d = setup({
      runSdk: async () => {
        throw new Error('boom');
      },
    });
    await assert.rejects(d.call('interactive'), (err: Error) => {
      assert.doesNotMatch(err.message, /FAKE/);
      return true;
    });

    assert.ok(notices.length >= 4, `expected several notices, got ${notices.length}`);
    assert.ok(results.some((r) => r.stopped));
    assert.ok(results.some((r) => r.deferred));
    for (const n of notices) assert.doesNotMatch(JSON.stringify(n), /FAKE/);
    for (const r of results) {
      assert.doesNotMatch(r.text, /FAKE/);
      assert.doesNotMatch(JSON.stringify(r), /FAKE/);
    }
    for (const f of files) assert.doesNotMatch(f, /FAKE|sk-ant/);
    // the call input handed to runSdk does not serialise the secret either
    for (const i of a.calls) {
      assert.doesNotMatch(JSON.stringify(i), /FAKE/);
      assert.doesNotMatch(JSON.stringify({ ...i }), /FAKE/);
      assert.doesNotMatch(inspect(i, { depth: 10 }), /FAKE/);
    }
  });

  it('state write failure does not fail the call', async () => {
    const base = mkdtempSync(join(tmpdir(), 'robin-chain-'));
    const file = join(base, 'a-file');
    writeFileSync(file, 'x');
    const h = setup({ userData: join(file, 'user-data') });
    h.queue.push(limited());
    const res = await h.call('interactive');
    // routing still advances in-memory within the call
    assert.equal(res.credential, 'shared:subscription');
    assert.equal(res.text, 'done');
  });

  it('a throwing notifier or mode reader does not fail the call', async () => {
    const h = setup();
    h.deps.notify = async () => {
      throw new Error('discord down');
    };
    h.deps.mode = () => {
      throw new Error('bad yaml');
    };
    h.queue.push(limited());
    const res = await h.call('interactive');
    assert.equal(res.credential, 'shared:subscription');
  });

  it('default mode reads policies defensively (auto without the field)', async () => {
    const h = setup();
    delete h.deps.mode;
    h.queue.push(limited());
    const res = await h.call('interactive');
    assert.equal(res.credential, 'shared:subscription');
  });
});
