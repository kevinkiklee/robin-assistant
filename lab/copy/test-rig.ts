// lab/copy/test-rig.ts — shared by day/profile/score tests (not itself a test file)
import { join } from 'node:path';
import { resetPrompts, setPrompts } from '../../system/brain/cognition/prompts.ts';
import type { LLMDispatcher } from '../../system/brain/llm/dispatcher.ts';
import { closeDb, openDb, type RobinDb } from '../../system/brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../system/brain/memory/migrations/index.ts';
import { resetTuning } from '../../system/brain/memory/tuning.ts';
import { buildLabDispatcher } from '../llm/lab-dispatcher.ts';
import type { TemplateProvider } from '../llm/template-provider.ts';
import { simPrompts } from '../privacy/sim-prompts.ts';
import { padDoc, padTurns, type StreamItem } from '../render/template.ts';
import {
  createSandbox,
  createSimClock,
  enterSandbox,
  type Sandbox,
  type SimClock,
} from '../sandbox/sandbox.ts';
import { type CopyDayResult, dayStartMs, runCopyDay } from './day.ts';
import { labSteps } from './profile.ts';
import { openRouteLedger, type RouteLedger } from './routes.ts';

export interface Rig {
  sb: Sandbox;
  clock: SimClock;
  db: RobinDb;
  llm: LLMDispatcher;
  template: TemplateProvider;
  routes: RouteLedger;
  startDate: string;
  done(): void;
}

export function rig(startDate = '2027-01-04'): Rig {
  const sb = createSandbox();
  const clock = createSimClock(dayStartMs(startDate, 0));
  const exit = enterSandbox(sb, clock, { livePaths: ['/nonexistent-live'] });
  setPrompts(simPrompts());
  const { llm, template } = buildLabDispatcher({ mode: 'template' });
  const db = openDb(sb.dbPath);
  applyMigrations(db, allMigrations);
  const routes = openRouteLedger(join(sb.root, 'routes.jsonl'));
  return {
    sb,
    clock,
    db,
    llm,
    template: template as TemplateProvider,
    routes,
    startDate,
    done: () => {
      closeDb(db);
      resetTuning();
      resetPrompts();
      exit();
      sb.dispose();
    },
  };
}

export async function runDays(
  r: Rig,
  byDay: Record<number, StreamItem[]>,
  n: number,
  steps = labSteps('template'),
): Promise<CopyDayResult[]> {
  const out: CopyDayResult[] = [];
  for (let day = 0; day < n; day++) {
    out.push(
      await runCopyDay({
        db: r.db,
        llm: r.llm,
        clock: r.clock,
        sandbox: r.sb,
        day,
        dayStartMs: dayStartMs(r.startDate, day),
        items: byDay[day] ?? [],
        steps,
        routes: r.routes,
        template: r.template,
      }),
    );
  }
  return out;
}

export function groupByDay(items: StreamItem[]): Record<number, StreamItem[]> {
  const out: Record<number, StreamItem[]> = {};
  for (const it of items) {
    out[it.day] ??= [];
    out[it.day].push(it);
  }
  return out;
}

export const sessionItem = (
  sessionId: string,
  day: number,
  minute: number,
  sentences: string[],
): StreamItem => ({
  type: 'session',
  id: sessionId,
  day,
  minute,
  sessionId,
  filler: false,
  turns: padTurns(
    sessionId,
    sentences.flatMap((s) => [
      { role: 'user' as const, content: s },
      { role: 'assistant' as const, content: 'Noted.' },
    ]),
  ),
});
export const docItem = (
  id: string,
  day: number,
  minute: number,
  path: string,
  body: string,
): StreamItem => ({
  type: 'doc',
  id,
  day,
  minute,
  path,
  body: padDoc(id, body),
});
export const callItem = (
  id: string,
  day: number,
  minute: number,
  tool: 'believe' | 'record_correction',
  fidelity: 'correct' | 'sloppy-topic' | 'wrong-value' | 'omitted',
  slot: string,
  label: string,
  value: string,
  topic = slot,
): StreamItem => ({
  type: 'assistant-call',
  id,
  day,
  minute,
  tool,
  fidelity,
  slot,
  topic,
  label,
  value,
});
