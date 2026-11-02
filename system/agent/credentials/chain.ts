import { loadPolicies } from '../../kernel/config/load.ts';
import { notifyOperator } from '../../lib/notify/operator.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import {
  isSubscriptionLimitBanner,
  type RunSdkInput,
  runSdk as realRunSdk,
  type SdkResult,
} from '../sdk.ts';
import { type Credential, describe, loadCredentials } from './config.ts';
import { type CallClass, modelFamily, type Selection, selectCredential } from './select.ts';
import {
  type ChainState,
  type CredentialState,
  CredentialStateStore,
  type LimitState,
  scopeOf,
  statePath,
} from './state.ts';

/**
 * The credential chain: every Claude SDK call goes through here. It picks a
 * credential (select.ts), hands its env to the SDK child only, records what the
 * call taught us about that credential's limits, retries on the next credential
 * when the call did no work, and tells the operator — by credential name and
 * fingerprint only — when routing changes.
 *
 * Secrets: a credential's env is read in exactly one place (`credentialEnv` on
 * the runSdk input). Nothing here logs; notices and returned text are built from
 * `describe()`/names; the state file stores fingerprints.
 */

export interface ChainDeps {
  runSdk?: (i: RunSdkInput) => Promise<SdkResult>;
  env?: Record<string, string | undefined>;
  userData?: () => string;
  mode?: () => 'auto' | 'manual';
  now?: () => number;
  notify?: (p: { title: string; message: string; silent?: boolean }) => Promise<unknown>;
}

export interface ChainResult extends SdkResult {
  /** Credential.id that served the call. */
  credential?: string;
  deferred?: boolean;
  stopped?: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Mirrors select.ts: a warning, or a rejection with no reset, is re-probed after this. */
const STALE_MS = 30 * MIN;
const SOFT_WINDOW_MS = 10 * MIN;
const SOFT_HITS_TO_WARN = 3;
const AUTH_BENCH_MS = 6 * HOUR;
const TOKEN_LIFETIME_MS = 365 * DAY;
const EXPIRY_WARN_MS = 30 * DAY;
const EXPIRY_NOTICE_EVERY_MS = 7 * DAY;
const NOTICE_DEDUPE_MS = 6 * HOUR;
const TITLE = 'Robin: Claude credentials';

type Family = ReturnType<typeof modelFamily>;
type Notify = NonNullable<ChainDeps['notify']>;

/**
 * Process-lifetime stand-in for a state file that can't be written, keyed by its
 * path ('' = no user-data dir). Without it every call would start from empty
 * state: a refused token re-tried and re-notified on every call.
 */
const memoryFallback = new Map<string, ChainState>();

/** State that persists when it can and silently stays in process memory when it can't. */
class StateHandle {
  state: ChainState;
  private readonly store?: CredentialStateStore;
  private readonly key: string;

  constructor(store?: CredentialStateStore) {
    this.store = store;
    this.key = store?.path ?? '';
    this.state =
      memoryFallback.get(this.key) ?? (store ? store.read() : { version: 1, credentials: {} });
  }

  mutate(fn: (s: ChainState) => void): void {
    const mem = memoryFallback.get(this.key);
    if (mem) {
      fn(mem);
      this.state = mem;
    }
    if (this.store) {
      try {
        // Once writable again, the in-memory credentials are written back whole.
        this.state = this.store.update((s) => {
          if (mem) s.credentials = mem.credentials;
          else fn(s);
        });
        memoryFallback.delete(this.key);
        return;
      } catch {
        // unwritable: carry on from memory
      }
    }
    if (!mem) {
      fn(this.state);
      memoryFallback.set(this.key, this.state);
    }
  }
}

function openStore(userData: () => string, now: () => number): CredentialStateStore | undefined {
  try {
    return new CredentialStateStore(statePath(userData()), now);
  } catch {
    return undefined;
  }
}

function resolveMode(deps: ChainDeps, userData: () => string): 'auto' | 'manual' {
  try {
    if (deps.mode) return deps.mode() === 'manual' ? 'manual' : 'auto';
    // `account_rotation` joins the schema later; read it without assuming it exists.
    const agent = loadPolicies(userData()).agent as { account_rotation?: unknown };
    return agent.account_rotation === 'manual' ? 'manual' : 'auto';
  } catch {
    return 'auto';
  }
}

function known(ms: number | undefined): ms is number {
  return ms !== undefined && Number.isFinite(ms);
}

function localTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Same expiry rule as select.ts `levelOf`: false once the limit no longer counts. */
function isActive(l: LimitState, nowMs: number): boolean {
  if (l.resetsAtMs !== undefined && l.resetsAtMs <= nowMs) return false;
  if (l.status === 'rejected' && l.resetsAtMs !== undefined) return true;
  return l.observedAtMs + STALE_MS > nowMs;
}

function inFamily(l: LimitState, family: Family): boolean {
  return l.scope === 'all' || l.scope === family;
}

function softHits(cs: CredentialState, nowMs: number): number[] {
  return (cs.softHitsAtMs ?? []).filter((t) => t >= nowMs - SOFT_WINDOW_MS && t <= nowMs);
}

/**
 * The state selection should see: entries for a rotated token (fingerprint
 * changed) are dropped, and a soft-signal warning lapses as soon as fewer than
 * three soft hits remain in the window.
 */
function selectionView(state: ChainState, credentials: Credential[], nowMs: number): ChainState {
  const view: ChainState = { ...state, credentials: {} };
  for (const c of credentials) {
    const cs = state.credentials[c.id];
    if (!cs || cs.fingerprint !== c.fingerprint) continue;
    const lapsed = softHits(cs, nowMs).length < SOFT_HITS_TO_WARN;
    view.credentials[c.id] = {
      ...cs,
      limits: cs.limits.filter((l) => !(l.reason === 'soft' && lapsed)),
    };
  }
  return view;
}

/** When a credential's rejections in this model family are expected to clear. */
function clearsAtMs(cs: CredentialState | undefined, family: Family, nowMs: number) {
  let out: number | undefined;
  for (const l of cs?.limits ?? []) {
    if (l.status !== 'rejected' || !inFamily(l, family) || !isActive(l, nowMs)) continue;
    const t = l.resetsAtMs ?? l.observedAtMs + STALE_MS;
    out = Math.max(out ?? t, t);
  }
  return out;
}

/** Known reset (not the 30-min re-probe guess) of a credential's rejections. */
function knownResetMs(cs: CredentialState | undefined, family: Family, nowMs: number) {
  let out: number | undefined;
  for (const l of cs?.limits ?? []) {
    if (l.status !== 'rejected' || !inFamily(l, family) || !isActive(l, nowMs)) continue;
    if (l.resetsAtMs === undefined) return undefined;
    out = Math.max(out ?? l.resetsAtMs, l.resetsAtMs);
  }
  return out;
}

function resetPhrase(ms: number | undefined): string {
  return known(ms) ? `resets ${localTime(ms)}` : 'reset time unknown';
}

type NoticeKind = 'borrow' | 'credit' | 'stop' | 'manual' | 'auth';

/**
 * One notice per (credential, kind) per 6 h, unless that credential's limit
 * cleared since — an `allowed` observation or a reset that passed. A banner
 * with no reset is re-probed every 30 min; that alone never re-notifies.
 */
function noticeDue(cs: CredentialState | undefined, kind: NoticeKind, nowMs: number): boolean {
  const last = cs?.noticesAtMs?.[kind];
  if (last === undefined || nowMs - last >= NOTICE_DEDUPE_MS) return true;
  if (cs?.limitClearedAtMs !== undefined && cs.limitClearedAtMs > last) return true;
  return !!cs?.limits.some(
    (l) => l.resetsAtMs !== undefined && l.resetsAtMs > last && l.resetsAtMs <= nowMs,
  );
}

interface Signal {
  /** A recorded refusal: the call did not get through on this credential. */
  hard: boolean;
  soft: boolean;
  bannerScope?: LimitState['scope'];
}

function bannerScope(text: string): LimitState['scope'] {
  if (/opus/i.test(text)) return 'opus';
  if (/sonnet/i.test(text)) return 'sonnet';
  return 'all';
}

function classify(result: SdkResult, emptyIsLimit: boolean): Signal {
  const ev = result.rateLimit;
  const noWork = result.structured === undefined;
  const banner = noWork && result.limitHit && isSubscriptionLimitBanner(result.text);
  // A rejected event alongside a usable answer is recorded, but the answer stands.
  const unusable = result.status !== 'success' || banner || (noWork && result.text.trim() === '');
  const out: Signal = {
    hard: !!result.authError || (ev?.status === 'rejected' && unusable) || banner,
    soft: false,
  };
  if (banner && ev?.status !== 'rejected') out.bannerScope = bannerScope(result.text);
  if (!ev && !banner && !result.authError) {
    const bare429 = result.limitHit;
    const empty =
      emptyIsLimit && noWork && result.status === 'success' && result.text.trim() === '';
    out.soft = bare429 || empty;
  }
  return out;
}

function upsert(cs: CredentialState, l: LimitState): void {
  const key = (x: LimitState) => `${x.scope}:${x.reason ?? 'limit'}`;
  cs.limits = [...cs.limits.filter((x) => key(x) !== key(l)), l];
}

function record(
  handle: StateHandle,
  c: Credential,
  result: SdkResult,
  signal: Signal,
  nowMs: number,
): void {
  handle.mutate((s) => {
    let cs = s.credentials[c.id];
    if (!cs || cs.fingerprint !== c.fingerprint) {
      cs = { fingerprint: c.fingerprint, firstSeenAtMs: nowMs, limits: [] };
      s.credentials[c.id] = cs;
    }
    cs.lastUsedAtMs = nowMs;
    const resets = cs.limits
      .map((l) => l.resetsAtMs)
      .filter((t): t is number => t !== undefined && t <= nowMs);
    if (resets.length) cs.limitClearedAtMs = Math.max(cs.limitClearedAtMs ?? 0, ...resets);
    cs.limits = cs.limits.filter((l) => isActive(l, nowMs));
    let hits = softHits(cs, nowMs);

    const ev = result.rateLimit;
    if (ev) {
      const scope = scopeOf(ev.type);
      if (ev.status === 'allowed') {
        const before = cs.limits.length;
        cs.limits = cs.limits.filter((l) => l.scope !== scope || l.reason === 'auth');
        if (cs.limits.length < before) cs.limitClearedAtMs = nowMs;
        if (scope === 'all') hits = [];
      } else {
        upsert(cs, {
          status: ev.status,
          scope,
          ...(ev.resetsAtMs !== undefined ? { resetsAtMs: ev.resetsAtMs } : {}),
          observedAtMs: nowMs,
          ...(ev.type !== undefined ? { type: ev.type } : {}),
          ...(ev.utilization !== undefined ? { utilization: ev.utilization } : {}),
        });
      }
    }
    if (signal.bannerScope) {
      upsert(cs, { status: 'rejected', scope: signal.bannerScope, observedAtMs: nowMs });
    }
    if (result.authError) {
      upsert(cs, {
        status: 'rejected',
        scope: 'all',
        resetsAtMs: nowMs + AUTH_BENCH_MS,
        observedAtMs: nowMs,
        reason: 'auth',
      });
    }
    if (signal.soft) hits.push(nowMs);
    if (signal.soft && hits.length >= SOFT_HITS_TO_WARN) {
      upsert(cs, { status: 'allowed_warning', scope: 'all', observedAtMs: nowMs, reason: 'soft' });
    } else if (hits.length < SOFT_HITS_TO_WARN) {
      cs.limits = cs.limits.filter((l) => l.reason !== 'soft');
    }
    if (hits.length) cs.softHitsAtMs = hits;
    else delete cs.softHitsAtMs;
  });
}

interface Ctx {
  credentials: Credential[];
  handle: StateHandle;
  notify: Notify;
  mode: 'auto' | 'manual';
  cls: CallClass;
  family: Family;
  now: () => number;
}

async function send(ctx: Ctx, message: string, silent: boolean): Promise<void> {
  try {
    await ctx.notify({ title: TITLE, message, silent });
  } catch {
    // a notice never fails the call
  }
}

/** Send a limit notice deduped per (`key`, `kind`); see `noticeDue`. */
async function limitNotice(
  ctx: Ctx,
  key: Credential,
  kind: NoticeKind,
  message: string,
  silent: boolean,
) {
  const nowMs = ctx.now();
  if (!noticeDue(ctx.handle.state.credentials[key.id], kind, nowMs)) return;
  ctx.handle.mutate((s) => {
    let cs = s.credentials[key.id];
    if (!cs) {
      cs = { fingerprint: key.fingerprint, firstSeenAtMs: nowMs, limits: [] };
      s.credentials[key.id] = cs;
    }
    cs.lastLimitNoticeAtMs = nowMs;
    cs.noticesAtMs = { ...cs.noticesAtMs, [kind]: nowMs };
  });
  await send(ctx, message, silent);
}

const sub = (ctx: Ctx, name: Credential['name']) =>
  ctx.credentials.find((c) => c.kind === 'subscription' && c.name === name);

/** Routing is about to move past the operator's first choice: say so (silent). */
async function noticeAdvance(ctx: Ctx, c: Credential, tried: string[], nowMs: number) {
  if (ctx.mode !== 'auto') return;
  const st = ctx.handle.state.credentials;
  if (c.kind === 'subscription' && c.name === 'shared') {
    const robin = sub(ctx, 'robin');
    if (!robin) return;
    const robinCs = st[robin.id];
    if (!tried.includes(robin.id) && clearsAtMs(robinCs, ctx.family, nowMs) === undefined) return;
    // A refused token already got its own (non-silent) notice.
    if (robinCs?.limits.some((l) => l.reason === 'auth' && isActive(l, nowMs))) return;
    await limitNotice(
      ctx,
      robin,
      'borrow',
      `Robin is borrowing your Claude account (robin limit, ${resetPhrase(knownResetMs(robinCs, ctx.family, nowMs))})`,
      true,
    );
  } else if (c.kind === 'credit') {
    const subs = ctx.credentials.filter((x) => x.kind === 'subscription');
    const key = subs.at(-1);
    if (!key) return;
    const resets = subs
      .map((x) => knownResetMs(st[x.id], ctx.family, nowMs))
      .filter((t): t is number => t !== undefined);
    await limitNotice(
      ctx,
      key,
      'credit',
      `Robin is using API credit (both subscriptions limited, ${resetPhrase(resets.length === subs.length ? Math.min(...resets) : undefined)})`,
      true,
    );
  }
}

function manualCredential(ctx: Ctx): Credential | undefined {
  const pinned = ctx.handle.state.pinned;
  return (pinned && sub(ctx, pinned)) || sub(ctx, 'robin') || sub(ctx, 'shared');
}

async function manualNotice(ctx: Ctx, c: Credential): Promise<void> {
  const other = c.name === 'robin' ? 'shared' : 'robin';
  const who = c.name === 'robin' ? "Robin's Claude account" : 'Your Claude account';
  await limitNotice(
    ctx,
    c,
    'manual',
    `${who} hit its limit. Switch with: robin accounts use ${other}`,
    false,
  );
}

/** Notices owed once a call on `c` has been recorded. */
async function afterCall(ctx: Ctx, c: Credential, result: SdkResult, signal: Signal) {
  const nowMs = ctx.now();
  if (result.authError) {
    await limitNotice(
      ctx,
      c,
      'auth',
      `Claude ${describe(c)} was refused (${result.authError}) — run claude setup-token for that account and update daemon.env`,
      false,
    );
  } else if (signal.hard && ctx.mode === 'manual' && c.kind === 'subscription') {
    await manualNotice(ctx, c);
  }
  const cs = ctx.handle.state.credentials[c.id];
  if (c.kind !== 'subscription' || !cs) return;
  const left = cs.firstSeenAtMs + TOKEN_LIFETIME_MS - nowMs;
  if (left > EXPIRY_WARN_MS) return;
  if (
    cs.lastExpiryNoticeAtMs !== undefined &&
    nowMs - cs.lastExpiryNoticeAtMs < EXPIRY_NOTICE_EVERY_MS
  )
    return;
  ctx.handle.mutate((s) => {
    const x = s.credentials[c.id];
    if (x) x.lastExpiryNoticeAtMs = nowMs;
  });
  const days = Math.max(0, Math.ceil(left / DAY));
  await send(
    ctx,
    `Claude token for ${c.name} expires in ${days} days — run claude setup-token and update daemon.env`,
    true,
  );
}

interface Spend {
  costUsd: number;
  usage: SdkResult['usage'];
  costEstimated?: boolean;
}

function addSpend(a: Spend | undefined, r: SdkResult): Spend {
  if (!a) return { costUsd: r.costUsd, usage: { ...r.usage }, costEstimated: r.costEstimated };
  const cached =
    a.usage.cachedInputTokens === undefined && r.usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: (a.usage.cachedInputTokens ?? 0) + (r.usage.cachedInputTokens ?? 0) };
  return {
    costUsd: a.costUsd + r.costUsd,
    usage: {
      inputTokens: a.usage.inputTokens + r.usage.inputTokens,
      outputTokens: a.usage.outputTokens + r.usage.outputTokens,
      ...cached,
    },
    costEstimated: a.costEstimated || r.costEstimated,
  };
}

/** Fold earlier failed attempts' spend into the returned result, so the ledger sees it. */
function withPriorSpend(result: ChainResult, prior: Spend | undefined): ChainResult {
  if (!prior) return result;
  const total = addSpend(prior, result);
  return {
    ...result,
    costUsd: total.costUsd,
    usage: total.usage,
    ...(total.costEstimated ? { costEstimated: true } : {}),
  };
}

async function halt(
  ctx: Ctx,
  sel: Extract<Selection, { kind: 'defer' | 'stop' }>,
  tried: string[],
  prior: Spend | undefined,
  model: string | undefined,
): Promise<ChainResult> {
  const nowMs = ctx.now();
  let { reason, retryAfterMs } = sel;
  if (tried.length) {
    // Excluding this call's failures hides why they failed; ask again without.
    const again = selectCredential({
      credentials: ctx.credentials,
      state: selectionView(ctx.handle.state, ctx.credentials, nowMs),
      cls: ctx.cls,
      model,
      mode: ctx.mode,
      nowMs,
    });
    if (again.kind === 'defer' || again.kind === 'stop') ({ reason, retryAfterMs } = again);
  }
  const stopped = sel.kind === 'stop';

  const manual = ctx.mode === 'manual' ? manualCredential(ctx) : undefined;
  if (
    manual &&
    clearsAtMs(ctx.handle.state.credentials[manual.id], ctx.family, nowMs) !== undefined
  ) {
    await manualNotice(ctx, manual);
  } else if (stopped && ctx.mode === 'auto') {
    const until =
      retryAfterMs !== undefined
        ? nowMs + retryAfterMs
        : Math.min(
            ...ctx.credentials.map(
              (c) =>
                clearsAtMs(ctx.handle.state.credentials[c.id], ctx.family, nowMs) ??
                Number.POSITIVE_INFINITY,
            ),
          );
    const key = ctx.credentials.at(-1);
    if (key) {
      await limitNotice(
        ctx,
        key,
        'stop',
        known(until)
          ? `All Claude credentials are limited until ${localTime(until)}`
          : 'All Claude credentials are limited (reset time unknown)',
        false,
      );
    }
  }

  const base: ChainResult = {
    status: 'error',
    text: `${stopped ? 'quota exhausted' : 'quota deferred'}: ${reason}`,
    turns: 0,
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    raw: null,
    limitHit: true,
    ...(stopped ? { stopped: true } : { deferred: true }),
  };
  return prior ? { ...base, costUsd: prior.costUsd, usage: prior.usage } : base;
}

/**
 * Run one SDK call through the credential chain. With no credentials configured
 * this is exactly `runSdk(input)`. `emptyIsLimit` (provider path only) counts an
 * empty, non-structured, non-error completion as a soft limit signal.
 */
export async function runSdkWithCredentials(
  input: RunSdkInput,
  cls: CallClass,
  deps: ChainDeps = {},
  opts: { emptyIsLimit?: boolean } = {},
): Promise<ChainResult> {
  const run = deps.runSdk ?? realRunSdk;
  const credentials = loadCredentials(deps.env ?? process.env);
  if (credentials.length === 0) return run(input);

  const now = deps.now ?? Date.now;
  const userData = deps.userData ?? (() => resolveUserDataDir());
  const handle = new StateHandle(openStore(userData, now));
  const mode = resolveMode(deps, userData);
  const ctx: Ctx = {
    credentials,
    handle,
    notify: deps.notify ?? notifyOperator,
    mode,
    cls,
    family: modelFamily(input.model),
    now,
  };

  const tried: string[] = [];
  let prior: Spend | undefined;
  for (;;) {
    const nowMs = now();
    const sel = selectCredential({
      credentials,
      state: selectionView(handle.state, credentials, nowMs),
      cls,
      model: input.model,
      mode,
      exclude: tried,
      nowMs,
    });
    if (sel.kind === 'ambient') return run(input);
    if (sel.kind !== 'use') return halt(ctx, sel, tried, prior, input.model);

    const c = sel.credential;
    await noticeAdvance(ctx, c, tried, nowMs);
    // The secret rides only on `credentialEnv`, which runSdk applies to the child
    // env. `c.env` redacts itself under JSON.stringify and util.inspect.
    const result = await run({ ...input, credentialEnv: c.env });

    const signal = classify(result, opts.emptyIsLimit === true);
    record(handle, c, result, signal, now());
    await afterCall(ctx, c, result, signal);

    const noWork = result.turns <= 1 && result.structured === undefined;
    if (!(signal.hard && noWork)) {
      return withPriorSpend({ ...result, credential: c.id }, prior);
    }
    tried.push(c.id);
    prior = addSpend(prior, result);
  }
}
