// lab/copy/day.ts
//
// One simulated copy-day (spec §3.3): replay the day's stream items through the
// real memory pipeline, drain the biographer, dream at 03:50, and run weekly
// entity hygiene before Saturday.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runBiographer } from '../../system/brain/cognition/biographer.ts';
import { captureSession } from '../../system/brain/cognition/capture.ts';
import { type DreamStep, runDream } from '../../system/brain/cognition/dream.ts';
import { runEmbedder } from '../../system/brain/cognition/embedder.ts';
import { runEntityHygiene } from '../../system/brain/cognition/entity-hygiene.ts';
import { ingestContentDocs } from '../../system/brain/cognition/ingest-docs.ts';
import type { LLMDispatcher } from '../../system/brain/llm/dispatcher.ts';
import {
  type BeliefRecord,
  believe,
  normalizeTopic,
  recallBelief,
} from '../../system/brain/memory/belief.ts';
import type { RobinDb } from '../../system/brain/memory/db.ts';
import { clockDate, clockIso } from '../../system/lib/clock.ts';
import type { TemplateProvider } from '../llm/template-provider.ts';
import { claimSentence, parseClaim } from '../render/grammar.ts';
import type { StreamItem } from '../render/template.ts';
import type { Sandbox, SimClock } from '../sandbox/sandbox.ts';
import { writeHeadCapture } from './heads.ts';
import { BIOGRAPHER_OPTS } from './profile.ts';
import type { Route, RouteLedger } from './routes.ts';

export interface CopyDayInput {
  db: RobinDb;
  llm: LLMDispatcher;
  clock: SimClock;
  sandbox: Sandbox;
  day: number;
  dayStartMs: number;
  items: StreamItem[];
  steps: ReadonlySet<DreamStep>;
  routes: RouteLedger;
  /** Its stats.unhandled is copied into the result. */
  template: TemplateProvider | null;
}

export interface CopyDayResult {
  day: number;
  sessionsCaptured: number;
  /** skipReason → count */
  sessionsSkipped: Record<string, number>;
  /** Session ids; must stay empty. */
  disclosureSessionsSkipped: string[];
  /**
   * Disclosure sessions capture accepted but classified `category: 'dev'`: the biographer
   * selector never extracts those, so their disclosures are lost. Must stay empty.
   */
  disclosureSessionsUnextracted: string[];
  docsWritten: number;
  assistantCalls: number;
  biographerProcessed: number;
  candidatesPromoted: number;
  candidatesExpired: number;
  errors: string[];
  unhandledPrompts: string[];
}

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const DRAIN_MAX = 20;
const DREAM_MINUTE = 230; // 03:50 local
const HYGIENE_MINUTE = 330; // 05:30 local

export function dayStartMs(startDate: string, day: number): number {
  return Date.parse(`${startDate}T05:00:00Z`) + day * DAY_MS;
}

/** The category capture stamped on the event — what the biographer selector filters on. */
function capturedCategory(db: RobinDb, eventId: number): string | null {
  const row = db
    .prepare(`SELECT json_extract(payload, '$.category') AS c FROM events WHERE id = ?`)
    .get(eventId) as { c: string | null } | undefined;
  return row?.c ?? null;
}

export async function runCopyDay(input: CopyDayInput): Promise<CopyDayResult> {
  const { db, llm, clock, sandbox, routes } = input;
  const res: CopyDayResult = {
    day: input.day,
    sessionsCaptured: 0,
    sessionsSkipped: {},
    disclosureSessionsSkipped: [],
    disclosureSessionsUnextracted: [],
    docsWritten: 0,
    assistantCalls: 0,
    biographerProcessed: 0,
    candidatesPromoted: 0,
    candidatesExpired: 0,
    errors: [],
    unhandledPrompts: [],
  };

  const tick = async (): Promise<number> => {
    const b = await runBiographer(db, llm, 30, BIOGRAPHER_OPTS);
    const e = await runEmbedder(db, llm);
    if (e.status === 'skipped')
      res.errors.push(`embedder skipped: ${e.message ?? 'unknown error'}`);
    res.biographerProcessed += b.processed;
    res.errors.push(...b.errors);
    return b.processed;
  };

  const believeAs = (topic: string, label: string, value: string, route: Route): void => {
    // No provenance: matches the MCP `believe` tool path (server.ts).
    const r = believe(db, llm, { topic, claim: claimSentence(label, value), confidence: 0.9 });
    if (r.eventId > 0) routes.add(r.eventId, route);
  };

  // 1. Replay the day's items in order.
  for (const item of input.items) {
    clock.set(input.dayStartMs + item.minute * MIN_MS);
    switch (item.type) {
      case 'session': {
        const c = await captureSession(
          db,
          llm,
          { sessionId: item.sessionId, turns: item.turns, endedAt: clockIso() },
          { domainGating: true },
        );
        if (c.captured) {
          res.sessionsCaptured++;
          if (
            !item.filler &&
            c.eventId !== undefined &&
            capturedCategory(db, c.eventId) === 'dev'
          ) {
            res.disclosureSessionsUnextracted.push(item.sessionId);
          }
        } else {
          const reason = c.skipReason ?? 'unknown';
          res.sessionsSkipped[reason] = (res.sessionsSkipped[reason] ?? 0) + 1;
          if (!item.filler) res.disclosureSessionsSkipped.push(item.sessionId);
        }
        await tick();
        break;
      }
      case 'doc': {
        const path = join(sandbox.userDataDir, item.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, item.body);
        res.docsWritten++;
        ingestContentDocs(db, llm, { userDataDir: sandbox.userDataDir });
        await tick();
        break;
      }
      case 'assistant-call': {
        if (item.fidelity === 'omitted') break;
        res.assistantCalls++;
        if (item.tool === 'believe') {
          believeAs(item.topic, item.label, item.value, 'direct-believe');
          break;
        }
        const head = recallBelief(db, { topic: item.slot }) as BeliefRecord | null;
        if (head && parseClaim(head.claim)?.value !== item.value) {
          // The MCP `record_correction` statement (server.ts).
          db.prepare(
            `INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, 'lab', ?)`,
          ).run(head.claim, claimSentence(item.label, item.value), normalizeTopic(item.topic));
          believeAs(item.topic, item.label, item.value, 'correction-believe');
        } else {
          believeAs(item.topic, item.label, item.value, 'direct-believe');
        }
        break;
      }
      default: {
        const type = (item as { type: string }).type;
        throw new Error(`unknown stream item type: ${type}`);
      }
    }
  }

  // 2. End of day: drain the biographer queue (no wall-clock deadline under the sim clock).
  for (let i = 0; i < DRAIN_MAX; i++) {
    if ((await tick()) === 0) break;
  }

  // 3. Dream at 03:50 the next day.
  const next = input.dayStartMs + DAY_MS;
  clock.set(next + DREAM_MINUTE * MIN_MS);
  const dream = await runDream(db, llm, clockDate(), { domainGating: true, steps: input.steps });
  res.candidatesPromoted = dream.candidatesPromoted;
  res.candidatesExpired = dream.candidatesExpired;

  // 4. Weekly entity hygiene, Saturday morning.
  if (new Date(next).getUTCDay() === 6) {
    clock.set(next + HYGIENE_MINUTE * MIN_MS);
    await runEntityHygiene(db, llm, { apply: true });
  }

  // 5. Capture every belief row: a later same-local-day upsert would overwrite tonight's
  //    promotions in the final snapshot (see heads.ts).
  writeHeadCapture(db, sandbox.root, input.day);

  // 6. The pipeline may swallow LabUnhandledPromptError internally; surface every one.
  res.unhandledPrompts = [...(input.template?.stats.unhandled ?? [])];
  return res;
}
