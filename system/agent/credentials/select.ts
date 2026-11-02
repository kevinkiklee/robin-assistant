import type { Credential } from './config.ts';
import type { ChainState, CredentialState, LimitState } from './state.ts';

export type CallClass = 'interactive' | 'brief' | 'background';
export type Selection =
  | { kind: 'ambient' }
  | { kind: 'use'; credential: Credential }
  | { kind: 'defer'; reason: string; retryAfterMs?: number }
  | { kind: 'stop'; reason: string; retryAfterMs?: number };

type Family = 'opus' | 'sonnet' | 'other';
type Level = 'ok' | 'warning' | 'rejected';

const HALF_HOUR_MS = 30 * 60_000;
const WARNING_UTILIZATION = 0.85;

export function modelFamily(model?: string): Family {
  if (!model) return 'other';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  return 'other';
}

interface Assessment {
  level: Level;
  /** Absolute ms when the blocking limit is expected to clear. */
  clearsAtMs?: number;
  /** A refused token (not a quota limit). */
  auth: boolean;
}

const RANK: Record<Level, number> = { ok: 0, warning: 1, rejected: 2 };

function levelOf(l: LimitState, nowMs: number): Level | undefined {
  if (l.resetsAtMs !== undefined && l.resetsAtMs <= nowMs) return undefined;
  if (l.status === 'rejected') {
    if (l.resetsAtMs === undefined && l.observedAtMs + HALF_HOUR_MS <= nowMs) return undefined;
    return 'rejected';
  }
  if (l.observedAtMs + HALF_HOUR_MS <= nowMs) return undefined;
  return l.utilization === undefined || l.utilization >= WARNING_UTILIZATION ? 'warning' : 'ok';
}

function assess(cs: CredentialState | undefined, family: Family, nowMs: number): Assessment {
  const out: Assessment = { level: 'ok', auth: false };
  for (const l of cs?.limits ?? []) {
    if (l.scope !== 'all' && l.scope !== family) continue;
    const level = levelOf(l, nowMs);
    if (!level || level === 'ok') continue;
    // A warning is re-probed after 30 min whatever its reset says.
    const clearsAtMs =
      level === 'warning'
        ? Math.min(l.resetsAtMs ?? Number.POSITIVE_INFINITY, l.observedAtMs + HALF_HOUR_MS)
        : (l.resetsAtMs ?? l.observedAtMs + HALF_HOUR_MS);
    if (RANK[level] > RANK[out.level]) {
      out.level = level;
      out.clearsAtMs = clearsAtMs;
      out.auth = level === 'rejected' && l.reason === 'auth';
    } else if (level === out.level) {
      // blocked until the credential's last blocker clears
      out.clearsAtMs = Math.max(out.clearsAtMs ?? clearsAtMs, clearsAtMs);
      if (level === 'rejected' && l.reason === 'auth') out.auth = true;
    }
  }
  return out;
}

export function effectiveLimit(
  cs: CredentialState | undefined,
  family: Family,
  nowMs: number,
): Level {
  return assess(cs, family, nowMs).level;
}

/** Per-class tier order as data; read this to see who serves what. */
const TIERS: Record<
  CallClass,
  Array<{ kind: Credential['kind']; names: Array<Credential['name']> }>
> = {
  interactive: [
    { kind: 'subscription', names: ['robin', 'shared'] },
    { kind: 'credit', names: ['robin', 'shared'] },
  ],
  brief: [
    { kind: 'subscription', names: ['robin', 'shared'] },
    { kind: 'credit', names: ['robin', 'shared'] },
  ],
  background: [{ kind: 'subscription', names: ['robin', 'shared'] }],
};

export function selectCredential(args: {
  credentials: Credential[];
  state: ChainState;
  cls: CallClass;
  model?: string;
  mode: 'auto' | 'manual';
  /** ids already tried this call */
  exclude?: string[];
  nowMs: number;
}): Selection {
  const { credentials, state, cls, mode, nowMs } = args;
  if (credentials.length === 0) return { kind: 'ambient' };

  const family = modelFamily(args.model);
  const excluded = new Set(args.exclude ?? []);
  const find = (kind: Credential['kind'], name: Credential['name']) =>
    credentials.find((c) => c.kind === kind && c.name === name);

  // A missing Robin token is not "Robin exhausted": never borrow without it.
  if (mode === 'auto' && cls !== 'interactive' && !find('subscription', 'robin')) {
    return { kind: 'defer', reason: 'no Robin credential configured — background work paused' };
  }

  let candidates: Credential[];
  if (mode === 'manual') {
    const pinned =
      (state.pinned && find('subscription', state.pinned)) ||
      find('subscription', 'robin') ||
      find('subscription', 'shared');
    candidates = pinned ? [pinned] : [];
  } else {
    candidates = TIERS[cls].flatMap((t) =>
      t.names.map((n) => find(t.kind, n)).filter((c): c is Credential => !!c),
    );
  }
  candidates = candidates.filter((c) => !excluded.has(c.id));

  const strict = cls !== 'interactive';
  const blockers: Assessment[] = [];
  // Strict classes borrow `shared` only once `robin` is rejected (and, for
  // background, not when the rejection is a refused token).
  let robinGate: Assessment | undefined;
  const robinSub = find('subscription', 'robin');
  if (strict && robinSub && mode === 'auto') {
    robinGate = assess(state.credentials[robinSub.id], family, nowMs);
  }

  // Brief reaches the credit tier only when every configured subscription is
  // recorded as rejected; a mere warning defers. `exclude` never counts.
  const subsExhausted = credentials
    .filter((c) => c.kind === 'subscription')
    .every((c) => assess(state.credentials[c.id], family, nowMs).level === 'rejected');

  for (const c of candidates) {
    if (cls === 'brief' && c.kind === 'credit' && !subsExhausted) continue;
    const a = assess(state.credentials[c.id], family, nowMs);
    if (
      strict &&
      c.kind === 'subscription' &&
      c.name === 'shared' &&
      robinGate &&
      (robinGate.level !== 'rejected' || (cls === 'background' && robinGate.auth))
    ) {
      continue; // robin's own blocker is already recorded
    }
    const usable = strict && c.kind === 'subscription' ? a.level === 'ok' : a.level !== 'rejected';
    if (usable) return { kind: 'use', credential: c };
    blockers.push(a);
  }

  const times = blockers.map((b) => b.clearsAtMs).filter((t): t is number => t !== undefined);
  const retryAfterMs = times.length ? Math.max(0, Math.min(...times) - nowMs) : undefined;
  const reason = blockers.some((b) => b.auth)
    ? 'credential token refused'
    : candidates.length
      ? 'credentials at or near limit'
      : 'no eligible credential';
  return cls === 'interactive'
    ? { kind: 'stop', reason, retryAfterMs }
    : { kind: 'defer', reason, retryAfterMs };
}
