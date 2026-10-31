export type FactKind = 'trip' | 'gear' | 'preference' | 'routine';
export type Clarity = 'explicit' | 'hedged' | 'implied';
export type Channel = 'session' | 'doc';
export type Cause = 'decide' | 'drop' | 'buy' | 'return' | 'reverse';

export interface Slot {
  key: string; // kebab topic, canonical-stable, e.g. 'juniper-canyon-trip'
  label: string; // words, e.g. 'juniper canyon trip'
  kind: FactKind;
  domain: 'travel' | 'creative' | 'preferences' | 'health';
  values: readonly string[]; // every value this slot can take
  bait: boolean; // gear discussed, never bought; 'owned' is never true
}

export interface Fact {
  id: string;
  slot: string;
  value: string;
  validFrom: number; // sim day
  validTo: number | null; // exclusive; null = still true at horizon
}

export interface TruthChange {
  day: number;
  slot: string;
  factId: string; // the new fact
  from: string | null;
  to: string;
  cause: Cause;
}

export interface Disclosure {
  id: string;
  slot: string;
  factId: string;
  value: string;
  clarity: Clarity;
  channel: Channel;
  kind: 'state' | 'reassert' | 'bait-talk';
  lagDays: number | null; // null = never disclosed
  day: number | null; // change day + lag; null when never or past the horizon
  minute: number; // minute of day 0..1439 (ignored when day is null)
  sessionId: string | null; // set for rendered session disclosures
}

export type AssistantFidelity = 'correct' | 'sloppy-topic' | 'wrong-value' | 'omitted';
export interface AssistantCall {
  disclosureId: string;
  tool: 'believe' | 'record_correction';
  fidelity: AssistantFidelity;
  wrongValue: string | null; // set when fidelity is 'wrong-value'
}

export interface SessionPlan {
  id: string; // unique, e.g. 's1-0005-02'
  day: number;
  minute: number;
  disclosureIds: string[]; // empty for filler
  filler: boolean;
}

export interface Script {
  seed: number;
  horizonDays: number;
  startDate: string; // 'YYYY-MM-DD'
  slots: Slot[];
  facts: Fact[];
  changes: TruthChange[];
  disclosures: Disclosure[];
  assistantCalls: AssistantCall[];
  sessions: SessionPlan[];
  probes: Probe[]; // filled by Task 6's generateProbes; [] after generateScript
}

export type ProbeKind =
  | 'current'
  | 'superseded'
  | 'never-true'
  | 'corrected'
  | 'historical'
  | 'abstain';
export interface Probe {
  id: string;
  day: number;
  kind: ProbeKind;
  slot: string;
  question: string;
  acceptable: string[]; // asserted values that count as correct ([] for abstain)
  forbidden: string[]; // asserted values that count as wrong regardless
}
