import { canonicalizeTopic, normalizeTopic } from '../../system/brain/memory/belief.ts';
import { levenshtein } from '../../system/lib/levenshtein.ts';
import { GEAR, PLACES, PREFERENCE_VALUES, ROUTINES } from './names.ts';
import type { ScriptParams } from './params.ts';
import { chance, int, mulberry32, pick, type Rng, weighted } from './rng.ts';
import { compareDisclosures } from './truth.ts';
import type {
  AssistantCall,
  Cause,
  Disclosure,
  Fact,
  FactKind,
  Script,
  SessionPlan,
  Slot,
  TruthChange,
} from './types.ts';

export const MIN_SLOT_DISTANCE = 0.5;

/**
 * Event minutes are drawn in 01:00–22:59 of the sim day (and the renderer clamps
 * assistant-call minutes to EVENT_MINUTE_MAX). Sim days start at a fixed 05:00Z (EST
 * midnight); under DST local time runs an hour ahead, so 22:59 + 1 h still lands
 * before local midnight and no event crosses into the next local date.
 */
export const EVENT_MINUTE_MIN = 60;
export const EVENT_MINUTE_MAX = 1379;
const eventMinute = (r: Rng): number => int(r, EVENT_MINUTE_MIN, EVENT_MINUTE_MAX);

const CHAINS: Record<
  Exclude<FactKind, 'preference'>,
  { start: string; next: Record<string, string[]>; values: string[] }
> = {
  trip: {
    start: 'idea',
    next: {
      idea: ['considering', 'dropped'],
      considering: ['planned', 'dropped'],
      planned: ['booked', 'dropped'],
      booked: ['happened', 'dropped'],
    },
    values: ['idea', 'considering', 'planned', 'booked', 'happened', 'dropped'],
  },
  gear: {
    start: 'wanted',
    next: { wanted: ['ordered'], ordered: ['owned'], owned: ['returned', 'sold'] },
    values: ['wanted', 'ordered', 'owned', 'returned', 'sold'],
  },
  routine: {
    start: 'planned',
    next: { planned: ['active'], active: ['stopped'] },
    values: ['planned', 'active', 'stopped'],
  },
};

const DOMAIN: Record<FactKind, Slot['domain']> = {
  trip: 'travel',
  gear: 'creative',
  preference: 'preferences',
  routine: 'health',
};
const LABEL_SUFFIX: Record<FactKind, string> = {
  trip: 'trip',
  gear: 'gear',
  preference: 'pick',
  routine: 'habit',
};

function causeFor(kind: FactKind, from: string | null, to: string): Cause {
  if (from === null) return 'decide';
  if (to === 'dropped' || to === 'stopped') return 'drop';
  if (to === 'owned' || to === 'ordered') return 'buy';
  if (to === 'returned' || to === 'sold') return 'return';
  return kind === 'preference' ? 'reverse' : 'decide';
}

function shuffle<T>(r: Rng, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const ONSET = [
  'b',
  'd',
  'f',
  'g',
  'k',
  'l',
  'm',
  'p',
  'r',
  's',
  't',
  'v',
  'z',
  'br',
  'kl',
  'tr',
  'sh',
];
const NUCLEUS = ['a', 'e', 'i', 'o', 'u'];
const CODA = ['', '', 'n', 'l', 'r', 'k', 's', 'm'];
/** Whole tokens the topic canonicalizer would strip or treat specially. */
const BANNED_TOKENS = new Set([
  'no',
  'not',
  'non',
  'new',
  'my',
  'never',
  'info',
  'fact',
  'claim',
  'claims',
  'status',
  'update',
  'updated',
  'current',
  'currently',
  'latest',
  'recent',
  'belief',
  'isnt',
  'doesnt',
  'dont',
  'without',
]);

function syntheticWord(r: Rng): string {
  const syllables = int(r, 2, 4);
  let w = '';
  for (let i = 0; i < syllables; i++) {
    w += pick(r, ONSET) + pick(r, NUCLEUS) + (i === syllables - 1 ? pick(r, CODA) : '');
  }
  return w;
}

export class SlotNamer {
  private keys: string[] = [];
  constructor(
    private r: Rng,
    private maxAttempts = 4000,
  ) {}

  private accept(kind: FactKind, base: string): { label: string; key: string } | null {
    if (base.split(' ').some((t) => BANNED_TOKENS.has(t))) return null;
    const label = `${base} ${LABEL_SUFFIX[kind]}`;
    const key = normalizeTopic(label);
    if (canonicalizeTopic(key) !== key) return null;
    const far = this.keys.every(
      (k) => levenshtein(k, key) / Math.max(k.length, key.length) >= MIN_SLOT_DISTANCE,
    );
    if (!far) return null;
    this.keys.push(key);
    return { label, key };
  }

  /** Readable pool entries first (shuffled), then seeded synthetic two-word names. */
  take(kind: FactKind, pool: readonly string[]): { label: string; key: string } | null {
    for (const base of shuffle(this.r, pool)) {
      const hit = this.accept(kind, base);
      if (hit) return hit;
    }
    for (let i = 0; i < this.maxAttempts; i++) {
      const hit = this.accept(kind, `${syntheticWord(this.r)} ${syntheticWord(this.r)}`);
      if (hit) return hit;
    }
    return null;
  }
}

export function generateScript(
  params: ScriptParams,
  seed: number,
  opts: { namerAttempts?: number } = {},
): Script {
  const r = mulberry32(seed);
  const H = params.horizonDays;
  const scale = (perYear: number) => Math.max(1, Math.round((perYear * H) / 365));
  const namer = new SlotNamer(r, opts.namerAttempts);
  const want = {
    trip: scale(params.perYear.trips),
    gear: scale(params.perYear.gear),
    routine: scale(params.perYear.routines),
    preference: scale(params.perYear.preferences),
  };
  const slots: Slot[] = [];
  const facts: Fact[] = [];
  const changes: TruthChange[] = [];
  let factN = 0;

  const addTimeline = (slot: Slot, timeline: { day: number; value: string }[]) => {
    let prev: Fact | null = null;
    for (const step of timeline) {
      if (step.day >= H) break;
      const f: Fact = {
        id: `f${factN++}`,
        slot: slot.key,
        value: step.value,
        validFrom: step.day,
        validTo: null,
      };
      if (prev) prev.validTo = step.day;
      changes.push({
        day: step.day,
        slot: slot.key,
        factId: f.id,
        from: prev?.value ?? null,
        to: f.value,
        cause: causeFor(slot.kind, prev?.value ?? null, f.value),
      });
      facts.push(f);
      prev = f;
    }
  };

  const chainTimeline = (kind: Exclude<FactKind, 'preference'>, bait: boolean) => {
    const c = CHAINS[kind];
    let day = int(r, 0, Math.max(0, H - 2));
    const out = [{ day, value: c.start }];
    if (bait) return out;
    let v = c.start;
    // A routine described as planned but never started stops here.
    if (kind === 'routine' && chance(r, 0.3)) return out;
    while (c.next[v]) {
      day += int(r, 3, 21);
      const opts = c.next[v];
      v = opts.length === 1 ? opts[0] : chance(r, kind === 'trip' ? 0.25 : 0.3) ? opts[1] : opts[0];
      out.push({ day, value: v });
    }
    return out;
  };

  const addSlot = (
    kind: FactKind,
    pool: readonly string[],
    values: readonly string[],
    bait = false,
  ) => {
    const name = namer.take(kind, pool);
    if (!name) {
      const got = slots.filter((s) => s.kind === kind).length;
      throw new Error(`slot namer shortfall: ${kind} ${got}/${want[kind]}`);
    }
    const slot: Slot = {
      key: name.key,
      label: name.label,
      kind,
      domain: DOMAIN[kind],
      values,
      bait,
    };
    slots.push(slot);
    return slot;
  };

  for (let i = 0; i < want.trip; i++) {
    const s = addSlot('trip', PLACES, CHAINS.trip.values);
    addTimeline(s, chainTimeline('trip', false));
  }
  for (let i = 0; i < want.gear; i++) {
    const bait = chance(r, params.baitShare);
    const s = addSlot('gear', GEAR, CHAINS.gear.values, bait);
    addTimeline(s, chainTimeline('gear', bait));
  }
  for (let i = 0; i < want.routine; i++) {
    const s = addSlot('routine', ROUTINES, CHAINS.routine.values);
    addTimeline(s, chainTimeline('routine', false));
  }
  for (let i = 0; i < want.preference; i++) {
    const vals = pick(r, PREFERENCE_VALUES);
    const s = addSlot('preference', [], vals);
    const start = int(r, 0, Math.max(0, H - 2));
    const first = pick(r, vals);
    const tl = [{ day: start, value: first }];
    if (chance(r, params.reverseShare)) {
      tl.push({
        day: start + int(r, 10, 60),
        value: pick(
          r,
          vals.filter((v) => v !== first),
        ),
      });
    }
    addTimeline(s, tl);
  }

  // Disclosures: one per truth change, plus bait talk and reassertions.
  const disclosures: Disclosure[] = [];
  let dN = 0;
  const lagDraw = (): number | null => {
    const x = r();
    const { sameDay, withinWeek, never } = params.lag;
    if (x < sameDay) return 0;
    if (x < sameDay + withinWeek) return int(r, 1, 7);
    if (x < sameDay + withinWeek + never) return null;
    return int(r, 8, 30);
  };
  const slotByKey = new Map(slots.map((s) => [s.key, s]));
  const factById = new Map(facts.map((f) => [f.id, f]));
  for (const c of changes) {
    const slot = slotByKey.get(c.slot) as Slot;
    const validTo = (factById.get(c.factId) as Fact).validTo;
    const lagDays = lagDraw();
    const day = lagDays === null || c.day + lagDays >= H ? null : c.day + lagDays;
    const clarity = weighted(r, params.clarity);
    const channel = slot.kind === 'trip' && chance(r, params.docShare) ? 'doc' : 'session';
    const minute = eventMinute(r);
    // A disclosure that would land on or after the next change is never emitted: by then
    // the user reports the newer state instead, so no rendered statement is already stale.
    if (day !== null && validTo !== null && day >= validTo) continue;
    disclosures.push({
      id: `d${dN++}`,
      slot: c.slot,
      factId: c.factId,
      value: c.to,
      clarity,
      channel,
      kind: 'state',
      lagDays,
      day,
      minute,
      sessionId: null,
    });
    if (day !== null && clarity === 'explicit' && chance(r, params.reassertShare)) {
      // Clamp the reassert inside the fact's validity (and the horizon); drop it when no
      // later day fits, so a "correction" never reasserts a value that is already dead.
      const last = Math.min(H - 1, validTo === null ? H - 1 : validTo - 1);
      const rday = Math.min(day + int(r, 2, 20), last);
      const rminute = eventMinute(r);
      if (rday > day) {
        disclosures.push({
          id: `d${dN++}`,
          slot: c.slot,
          factId: c.factId,
          value: c.to,
          clarity: 'explicit',
          channel: 'session',
          kind: 'reassert',
          lagDays: rday - c.day,
          day: rday,
          minute: rminute,
          sessionId: null,
        });
      }
    }
  }
  for (const slot of slots.filter((s) => s.bait)) {
    const f = facts.find((x) => x.slot === slot.key) as Fact;
    for (let k = 0; k < 3; k++) {
      // Clamp to the horizon so every bait slot has talk even when it starts late.
      const day = Math.min(H - 1, f.validFrom + int(r, 0, 20));
      disclosures.push({
        id: `d${dN++}`,
        slot: slot.key,
        factId: f.id,
        value: 'wanted',
        clarity: 'hedged',
        channel: 'session',
        kind: 'bait-talk',
        lagDays: day - f.validFrom,
        day,
        minute: eventMinute(r),
        sessionId: null,
      });
    }
  }

  // Sessions: group each day's session disclosures into ≤ disclosureSessionsPerDay sessions; add filler.
  const sessions: SessionPlan[] = [];
  for (let day = 0; day < H; day++) {
    const todays = disclosures
      .filter((d) => d.day === day && d.channel === 'session')
      .sort((a, b) => a.minute - b.minute || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const n = Math.min(params.disclosureSessionsPerDay, todays.length);
    for (let k = 0; k < n; k++) {
      const members = todays.filter((_, i) => i % n === k);
      const id = `s${seed}-${String(day).padStart(4, '0')}-${String(k).padStart(2, '0')}`;
      // A disclosure happens when its session does; turns follow compareDisclosures, the
      // comparator knowable() uses, so same-session order matches render order.
      const minute = members[0].minute;
      for (const d of members) {
        d.sessionId = id;
        d.minute = minute;
      }
      members.sort(compareDisclosures);
      sessions.push({
        id,
        day,
        minute,
        disclosureIds: members.map((d) => d.id),
        filler: false,
      });
    }
    for (let k = 0; k < params.fillerPerDay; k++) {
      sessions.push({
        id: `s${seed}-${String(day).padStart(4, '0')}-f${k}`,
        day,
        minute: eventMinute(r),
        disclosureIds: [],
        filler: true,
      });
    }
  }

  // Assistant calls on rendered explicit session disclosures.
  const assistantCalls: AssistantCall[] = [];
  for (const d of disclosures) {
    if (d.day === null || d.channel !== 'session' || d.clarity !== 'explicit') continue;
    if (d.kind !== 'reassert' && !chance(r, params.assistant.callRate)) continue;
    const a = params.assistant;
    const fidelity = weighted(r, {
      omitted: a.omitted,
      'sloppy-topic': a.sloppyTopic,
      'wrong-value': a.wrongValue,
      correct: Math.max(0, 1 - a.omitted - a.sloppyTopic - a.wrongValue),
    });
    const slot = slotByKey.get(d.slot) as Slot;
    const others = slot.values.filter((v) => v !== d.value);
    assistantCalls.push({
      disclosureId: d.id,
      tool: d.kind === 'reassert' ? 'record_correction' : 'believe',
      fidelity,
      wrongValue: fidelity === 'wrong-value' ? pick(r, others) : null,
    });
  }

  return {
    seed,
    horizonDays: H,
    startDate: params.startDate,
    slots,
    facts,
    changes,
    disclosures,
    assistantCalls,
    sessions,
    probes: [],
  };
}
