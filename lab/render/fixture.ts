import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateScript } from '../script/generate.ts';
import type { ScriptParams } from '../script/params.ts';
import { generateProbes } from '../script/probes.ts';
import type { Script } from '../script/types.ts';
import { compareItems, renderTemplate, type StreamItem } from './template.ts';

export interface FixtureMeta {
  seed: number;
  renderer: 'template';
  horizonDays: number;
  startDate: string;
  scriptSha: string;
  createdBy: string;
}

export function writeFixture(dir: string, script: Script, items: StreamItem[]): FixtureMeta {
  mkdirSync(dir, { recursive: true });
  const scriptText = `${JSON.stringify(script, null, 2)}\n`;
  const meta: FixtureMeta = {
    seed: script.seed,
    renderer: 'template',
    horizonDays: script.horizonDays,
    startDate: script.startDate,
    scriptSha: createHash('sha256').update(scriptText).digest('hex').slice(0, 16),
    createdBy: 'lab/render/fixture.ts',
  };
  writeFileSync(join(dir, 'script.json'), scriptText);
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(
    join(dir, 'stream.jsonl'),
    items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''),
  );
  return meta;
}

function readText(dir: string, file: string): string {
  const p = join(dir, file);
  if (!existsSync(p)) throw new Error(`fixture missing: ${file}`);
  return readFileSync(p, 'utf8');
}

export function readFixture(dir: string): {
  meta: FixtureMeta;
  script: Script;
  items: StreamItem[];
} {
  const meta = JSON.parse(readText(dir, 'meta.json')) as FixtureMeta;
  const script = JSON.parse(readText(dir, 'script.json')) as Script;
  const items = readText(dir, 'stream.jsonl')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as StreamItem);
  return { meta, script, items };
}

export function itemsForDay(items: StreamItem[], day: number): StreamItem[] {
  return items.filter((i) => i.day === day).sort(compareItems);
}

/** generate → probes → render → write */
export function buildFixture(dir: string, params: ScriptParams, seed: number): FixtureMeta {
  const script = generateScript(params, seed);
  script.probes = generateProbes(script);
  return writeFixture(dir, script, renderTemplate(script));
}
