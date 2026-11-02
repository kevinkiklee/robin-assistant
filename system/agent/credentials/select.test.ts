import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadCredentials } from './config.ts';
import { type CallClass, effectiveLimit, modelFamily, selectCredential } from './select.ts';
import type { ChainState, LimitState } from './state.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const ALL = loadCredentials({
  CLAUDE_TOKEN_ROBIN: 'sk-ant-oat01-FAKE-robin',
  CLAUDE_TOKEN_SHARED: 'sk-ant-oat01-FAKE-shared',
  CLAUDE_CREDIT_KEY_ROBIN: 'sk-ant-api03-FAKE-credit',
});

function st(limits: Record<string, Partial<LimitState>>, pinned?: 'robin' | 'shared'): ChainState {
  const credentials: ChainState['credentials'] = {};
  for (const [id, l] of Object.entries(limits)) {
    credentials[id] = {
      fingerprint: 'x',
      firstSeenAtMs: 0,
      limits: [{ status: 'rejected', scope: 'all', observedAtMs: NOW - MIN, ...l }],
    };
  }
  return { version: 1, credentials, pinned };
}

function pick(
  limits: Record<string, Partial<LimitState>>,
  cls: CallClass,
  extra: Partial<Parameters<typeof selectCredential>[0]> = {},
) {
  return selectCredential({
    credentials: ALL,
    state: st(limits, extra.state?.pinned),
    cls,
    mode: 'auto',
    nowMs: NOW,
    ...extra,
  });
}
const idOf = (s: ReturnType<typeof pick>) => (s.kind === 'use' ? s.credential.id : s.kind);
const reset = NOW + 60 * MIN;
const bothSubs = {
  'robin:subscription': { resetsAtMs: reset },
  'shared:subscription': { resetsAtMs: reset + MIN },
};

describe('modelFamily', () => {
  it('matches substrings', () => {
    assert.equal(modelFamily('claude-opus-5-5[1m]'), 'opus');
    assert.equal(modelFamily('claude-sonnet-5-5'), 'sonnet');
    assert.equal(modelFamily('claude-haiku'), 'other');
    assert.equal(modelFamily(), 'other');
  });
});

describe('effectiveLimit', () => {
  it('undefined state is ok', () => assert.equal(effectiveLimit(undefined, 'other', NOW), 'ok'));
});

describe('selectCredential', () => {
  it('ambient when none', () => {
    const s = selectCredential({
      credentials: [],
      state: { version: 1, credentials: {} },
      cls: 'background',
      mode: 'auto',
      nowMs: NOW,
    });
    assert.deepEqual(s, { kind: 'ambient' });
  });
  it('interactive prefers robin', () =>
    assert.equal(idOf(pick({}, 'interactive')), 'robin:subscription'));
  it('interactive borrows shared when robin rejected', () =>
    assert.equal(
      idOf(pick({ 'robin:subscription': { resetsAtMs: reset } }, 'interactive')),
      'shared:subscription',
    ));
  it('interactive uses credit when both subscriptions rejected', () =>
    assert.equal(idOf(pick(bothSubs, 'interactive')), 'robin:credit'));
  it('interactive stops when all rejected', () => {
    const s = pick({ ...bothSubs, 'robin:credit': { resetsAtMs: reset + 2 * MIN } }, 'interactive');
    assert.equal(s.kind, 'stop');
    assert.equal(s.kind === 'stop' && s.retryAfterMs, 60 * MIN);
  });
  it('background defers on robin warning (does not borrow shared)', () => {
    const s = pick({ 'robin:subscription': { status: 'allowed_warning' } }, 'background');
    assert.equal(s.kind, 'defer');
  });
  it('background borrows shared only when robin rejected', () => {
    assert.equal(
      idOf(pick({ 'robin:subscription': { resetsAtMs: reset } }, 'background')),
      'shared:subscription',
    );
  });
  it('background never uses credit', () => {
    const s = pick(bothSubs, 'background');
    assert.equal(s.kind, 'defer');
    assert.equal(s.kind === 'defer' && s.retryAfterMs, 60 * MIN);
  });
  it('refused token: background defers, brief borrows', () => {
    const l = { 'robin:subscription': { reason: 'auth' as const } };
    assert.equal(pick(l, 'background').kind, 'defer');
    assert.equal(idOf(pick(l, 'brief')), 'shared:subscription');
    assert.equal(idOf(pick(l, 'interactive')), 'shared:subscription');
  });
  it('brief uses credit when subs exhausted', () =>
    assert.equal(idOf(pick(bothSubs, 'brief')), 'robin:credit'));
  it('brief defers on robin warning', () =>
    assert.equal(
      pick({ 'robin:subscription': { status: 'allowed_warning' } }, 'brief').kind,
      'defer',
    ));
  it('exclude does not unlock shared', () => {
    const ex = { exclude: ['robin:subscription'] };
    assert.equal(pick({}, 'background', ex).kind, 'defer');
    assert.equal(pick({}, 'brief', ex).kind, 'defer');
    assert.equal(idOf(pick({}, 'interactive', ex)), 'shared:subscription');
  });
  it('warning retryAfter is at most 30 min', () => {
    const s = pick(
      {
        'robin:subscription': {
          status: 'allowed_warning',
          utilization: 0.95,
          observedAtMs: NOW,
          resetsAtMs: NOW + 3 * 24 * 60 * MIN,
        },
      },
      'background',
    );
    assert.equal(s.kind === 'defer' && s.retryAfterMs, 30 * MIN);
  });
  it("retryAfter waits for a credential's last blocker", () => {
    const state = st({});
    state.credentials['robin:subscription'] = {
      fingerprint: 'x',
      firstSeenAtMs: 0,
      limits: [
        { status: 'rejected', scope: 'all', observedAtMs: NOW, resetsAtMs: NOW + 10 * MIN },
        {
          status: 'rejected',
          scope: 'all',
          observedAtMs: NOW,
          resetsAtMs: NOW + 3 * 24 * 60 * MIN,
        },
      ],
    };
    const s = selectCredential({
      credentials: ALL.filter((c) => c.id === 'robin:subscription'),
      state,
      cls: 'interactive',
      mode: 'auto',
      nowMs: NOW,
    });
    assert.equal(s.kind === 'stop' && s.retryAfterMs, 3 * 24 * 60 * MIN);
  });
  it('shared-only: background and brief defer, interactive uses shared', () => {
    const credentials = ALL.filter((c) => c.id === 'shared:subscription');
    const run = (cls: CallClass) =>
      selectCredential({ credentials, state: st({}), cls, mode: 'auto', nowMs: NOW });
    assert.equal(run('background').kind, 'defer');
    assert.equal(run('brief').kind, 'defer');
    assert.equal(idOf(run('interactive')), 'shared:subscription');
  });
  it('model-scoped rejection', () => {
    const l = { 'robin:subscription': { scope: 'sonnet' as const, resetsAtMs: reset } };
    assert.equal(
      idOf(pick(l, 'interactive', { model: 'claude-sonnet-5-5' })),
      'shared:subscription',
    );
    assert.equal(
      idOf(pick(l, 'interactive', { model: 'claude-opus-5-5[1m]' })),
      'robin:subscription',
    );
  });
  it('model-scoped robin rejection never borrows for strict classes', () => {
    const l = { 'robin:subscription': { scope: 'sonnet' as const, resetsAtMs: reset } };
    const sonnet = { model: 'claude-sonnet-5-5' };
    const opus = { model: 'claude-opus-5-5[1m]' };
    assert.equal(pick(l, 'background', sonnet).kind, 'defer');
    assert.equal(pick(l, 'brief', sonnet).kind, 'defer');
    assert.equal(idOf(pick(l, 'background', opus)), 'robin:subscription');
    assert.equal(idOf(pick(l, 'brief', opus)), 'robin:subscription');
    assert.equal(idOf(pick(l, 'interactive', sonnet)), 'shared:subscription');
  });
  it('all-scope robin rejection still borrows shared for background', () =>
    assert.equal(
      idOf(
        pick({ 'robin:subscription': { resetsAtMs: reset } }, 'background', {
          model: 'claude-sonnet-5-5',
        }),
      ),
      'shared:subscription',
    ));
  it('expired rejection clears', () =>
    assert.equal(
      idOf(pick({ 'robin:subscription': { resetsAtMs: NOW - 1 } }, 'interactive')),
      'robin:subscription',
    ));
  it('warning below 0.85 is ok', () => {
    const w = (utilization?: number) => ({
      'robin:subscription': { status: 'allowed_warning' as const, utilization },
    });
    assert.equal(idOf(pick(w(0.57), 'background')), 'robin:subscription');
    assert.equal(pick(w(0.9), 'background').kind, 'defer');
    assert.equal(pick(w(undefined), 'background').kind, 'defer');
  });
  it('stale warning probes', () => {
    const l = {
      'robin:subscription': { status: 'allowed_warning' as const, observedAtMs: NOW - 31 * MIN },
    };
    assert.equal(idOf(pick(l, 'background')), 'robin:subscription');
  });
  it('rejected without reset lasts 30 min', () => {
    const r = (ago: number) => ({ 'robin:subscription': { observedAtMs: NOW - ago * MIN } });
    assert.equal(idOf(pick(r(29), 'interactive')), 'shared:subscription');
    assert.equal(idOf(pick(r(31), 'interactive')), 'robin:subscription');
  });
  it('exclude skips tried', () =>
    assert.equal(
      idOf(pick({}, 'interactive', { exclude: ['robin:subscription'] })),
      'shared:subscription',
    ));
  it('manual pins robin and never advances', () => {
    const s = pick({ 'robin:subscription': { resetsAtMs: reset } }, 'interactive', {
      mode: 'manual',
    });
    assert.equal(s.kind, 'stop');
    assert.equal(s.kind === 'stop' && s.retryAfterMs, 60 * MIN);
    assert.equal(pick(bothSubs, 'brief', { mode: 'manual' }).kind, 'defer');
  });
  it('manual honours pinned shared', () => {
    const state = st({}, 'shared');
    assert.equal(idOf(pick({}, 'interactive', { mode: 'manual', state })), 'shared:subscription');
  });
});
