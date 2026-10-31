import type { SessionTurn } from '../../system/brain/cognition/capture.ts';
import { canonicalizeTopic, normalizeTopic } from '../../system/brain/memory/belief.ts';
import { levenshtein } from '../../system/lib/levenshtein.ts';
import { EVENT_MINUTE_MAX } from '../script/generate.ts';
import { cmpCodePoint, compareDisclosures } from '../script/truth.ts';
import type { AssistantFidelity, Disclosure, Script, SessionPlan } from '../script/types.ts';
import { reassertSentence, stateSentence } from './grammar.ts';

/** Above the biographer's 1,000-char body floor (`MIN_SESSION_BODY_CHARS`), which also applies to docs. */
export const MIN_SESSION_CHARS = 1200;
/** Above `preprocessForExtraction`'s 50-char turn floor, which drops shorter turns before extraction. */
export const MIN_TURN_CHARS = 60;
const TURN_TAIL = ' Writing this down here so it stays on the record.';

export type StreamItem =
  | {
      type: 'session';
      id: string;
      day: number;
      minute: number;
      sessionId: string;
      filler: boolean;
      turns: SessionTurn[];
    }
  | { type: 'doc'; id: string; day: number; minute: number; path: string; body: string }
  | {
      type: 'assistant-call';
      id: string;
      day: number;
      minute: number;
      tool: 'believe' | 'record_correction';
      fidelity: AssistantFidelity;
      slot: string;
      topic: string;
      label: string;
      value: string;
    };

/**
 * Stream order: (day, minute, then sessions/docs before assistant calls, then id). The
 * call rank only matters when a clamped call minute ties its own session's minute.
 */
export function compareItems(a: StreamItem, b: StreamItem): number {
  const rank = (i: StreamItem) => (i.type === 'assistant-call' ? 1 : 0);
  return a.day - b.day || a.minute - b.minute || rank(a) - rank(b) || cmpCodePoint(a.id, b.id);
}
const bodyLen = (turns: SessionTurn[]): number => turns.reduce((n, t) => n + t.content.length, 0);

function sentenceFor(d: Disclosure, label: string): string {
  if (d.kind === 'reassert') return reassertSentence(label, d.value);
  if (d.kind === 'bait-talk') return stateSentence(label, d.value, 'hedged');
  return stateSentence(label, d.value, d.clarity);
}

/**
 * Lengthen short user turns past MIN_TURN_CHARS (a bare grammar sentence is ~45 chars and
 * the biographer would drop it), then append padding user/assistant pairs until the body
 * reaches MIN_SESSION_CHARS.
 */
export function padTurns(sessionId: string, turns: SessionTurn[]): SessionTurn[] {
  const out = turns.map((t) => {
    if (t.role !== 'user') return t;
    let content = t.content;
    while (content.length < MIN_TURN_CHARS) content += TURN_TAIL;
    return content === t.content ? t : { ...t, content };
  });
  for (let k = 1; bodyLen(out) < MIN_SESSION_CHARS; k++) {
    out.push({
      role: 'user',
      content: `Side note ${sessionId}-${k}: compared a few options and wrote down the details for later.`,
    });
    out.push({ role: 'assistant', content: 'Noted.' });
  }
  return out;
}

function fillerTurns(sessionId: string): SessionTurn[] {
  const out: SessionTurn[] = [];
  for (let k = 1; bodyLen(out) < MIN_SESSION_CHARS; k++) {
    out.push({
      role: 'user',
      content: `Refactor pass ${sessionId}-${k}: renamed the parser helper and reran the unit tests.`,
    });
    out.push({ role: 'assistant', content: 'Done, tests pass.' });
  }
  return out;
}

/** Append neutral note lines until a doc body clears the biographer's body floor. */
export function padDoc(key: string, body: string): string {
  let out = body.endsWith('\n') ? body : `${body}\n`;
  for (let k = 1; out.length < MIN_SESSION_CHARS; k++) {
    out += `\nNote ${key}-${k}: compared a few options and wrote down the details for later.\n`;
  }
  return out;
}

/**
 * Topic a sloppy assistant writes: `<first word>-notes`. Must be canonical-stable and
 * >= 0.4 normalized Levenshtein from the slot key, else believe()'s cross-slug gate
 * merges it back. Deterministic fallbacks cover slots where the first form fails.
 */
export function sloppyTopic(slotKey: string): string {
  const words = slotKey.split('-');
  const candidates = [
    `${words[0]}-notes`,
    `${words.slice(0, 2).join('-')}-notes`,
    `${words[0]}-side-notes`,
    `${words[0]}-misc-jottings`,
    `scratch-pad-notes-${words[0].slice(0, 3)}`,
    'misc-jottings-pad',
  ];
  for (const c of candidates) {
    if (canonicalizeTopic(normalizeTopic(c)) !== c) continue;
    if (levenshtein(c, slotKey) / Math.max(c.length, slotKey.length) >= 0.4) return c;
  }
  throw new Error(`no sloppy topic for slot ${slotKey}`);
}

export function renderTemplate(script: Script): StreamItem[] {
  const items: StreamItem[] = [];
  const slotByKey = new Map(script.slots.map((s) => [s.key, s]));
  const discById = new Map(script.disclosures.map((d) => [d.id, d]));
  const labelOf = (slot: string): string => slotByKey.get(slot)?.label ?? slot;

  for (const plan of script.sessions) {
    let turns: SessionTurn[];
    if (plan.filler) {
      turns = fillerTurns(plan.id);
    } else {
      turns = [];
      const members = plan.disclosureIds.map((id) => {
        const d = discById.get(id);
        if (!d) throw new Error(`session ${plan.id} names unknown disclosure ${id}`);
        return d;
      });
      for (const d of members.sort(compareDisclosures)) {
        turns.push({ role: 'user', content: sentenceFor(d, labelOf(d.slot)) });
        turns.push({ role: 'assistant', content: 'Noted.' });
      }
      turns = padTurns(plan.id, turns);
    }
    items.push({
      type: 'session',
      id: `session:${plan.id}`,
      day: plan.day,
      minute: plan.minute,
      sessionId: plan.id,
      filler: plan.filler,
      turns,
    });
  }

  // Doc disclosures: the doc grows like a decision tracker.
  const docsBySlot = new Map<string, Disclosure[]>();
  for (const d of script.disclosures) {
    if (d.channel !== 'doc' || d.day === null) continue;
    const list = docsBySlot.get(d.slot) ?? [];
    list.push(d);
    docsBySlot.set(d.slot, list);
  }
  for (const [slot, list] of docsBySlot) {
    list.sort(compareDisclosures);
    const label = labelOf(slot);
    list.forEach((d, i) => {
      const lines = list.slice(0, i + 1).map((x) => sentenceFor(x, label));
      items.push({
        type: 'doc',
        id: `doc:${d.id}`,
        day: d.day as number,
        minute: d.minute,
        path: `content/knowledge/sim/${slot}.md`,
        body: padDoc(slot, `# ${label}\n\n${lines.join('\n')}`),
      });
    });
  }

  // Assistant calls attach to session disclosures.
  const sessionOf = new Map<string, SessionPlan>();
  for (const p of script.sessions) for (const id of p.disclosureIds) sessionOf.set(id, p);
  const perSession = new Map<string, number>();
  for (const c of script.assistantCalls) {
    const d = discById.get(c.disclosureId);
    if (!d) throw new Error(`assistant call names unknown disclosure ${c.disclosureId}`);
    const plan = sessionOf.get(c.disclosureId);
    if (!plan) throw new Error(`assistant call on ${c.disclosureId} has no session plan`);
    if (c.fidelity === 'wrong-value' && c.wrongValue === null) {
      throw new Error(`wrong-value assistant call on ${c.disclosureId} has no wrongValue`);
    }
    const idx = perSession.get(plan.id) ?? 0;
    perSession.set(plan.id, idx + 1);
    items.push({
      type: 'assistant-call',
      id: `call:${c.disclosureId}`,
      day: plan.day,
      // Clamped so no call crosses local midnight (see EVENT_MINUTE_MAX).
      minute: Math.min(plan.minute + 1 + idx, EVENT_MINUTE_MAX),
      tool: c.tool,
      fidelity: c.fidelity,
      slot: d.slot,
      topic: c.fidelity === 'sloppy-topic' ? sloppyTopic(d.slot) : d.slot,
      label: labelOf(d.slot),
      value: c.fidelity === 'wrong-value' ? (c.wrongValue as string) : d.value,
    });
  }

  return items.sort(compareItems);
}
