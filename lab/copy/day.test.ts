// lab/copy/day.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { recallBelief } from '../../system/brain/memory/belief.ts';
import { stateSentence } from '../render/grammar.ts';
import { renderTemplate, type StreamItem } from '../render/template.ts';
import { generateScript } from '../script/generate.ts';
import { paramsWith } from '../script/params.ts';
import { generateProbes } from '../script/probes.ts';
import { openRouteLedger } from './routes.ts';
import { callItem, docItem, groupByDay, type Rig, rig, runDays, sessionItem } from './test-rig.ts';

let r: Rig | null = null;
afterEach(() => {
  r?.done();
  r = null;
});

test('copy-day §3.6: every channel reaches the belief store', { timeout: 120_000 }, async () => {
  r = rig();
  const items: StreamItem[] = [
    sessionItem('s-ch-1', 0, 600, [stateSentence('heron marsh trip', 'booked', 'explicit')]),
    docItem(
      'doc-1',
      0,
      700,
      'content/knowledge/sim/slate-ridge-trip.md',
      `# slate ridge trip\n\n${stateSentence('slate ridge trip', 'planned', 'explicit')}\n`,
    ),
    callItem('c-1', 0, 601, 'believe', 'correct', 'cedar-hollow-trip', 'cedar hollow trip', 'idea'),
  ];
  await runDays(r, { 0: items }, 9); // 7-day gate + margin
  for (const key of ['heron-marsh-trip', 'slate-ridge-trip', 'cedar-hollow-trip']) {
    const head = recallBelief(r.db, { topic: key });
    const cand = r.db
      .prepare('SELECT COUNT(*) n FROM belief_candidates WHERE topic = ?')
      .get(key) as { n: number };
    assert.ok(head || cand.n > 0, `channel for ${key} never reached the store`);
  }
});

test('copy-day: every disclosure session is captured; none dropped as duplicate', {
  timeout: 120_000,
}, async () => {
  r = rig();
  // Identical disclosure text across sessions: only the padding (session id) differs.
  const items = Array.from({ length: 12 }, (_, i) =>
    sessionItem(`s-dup-${i}`, 0, 500 + i, [
      stateSentence('opal lagoon trip', i % 2 ? 'idea' : 'planned', 'explicit'),
    ]),
  );
  const res = await runDays(r, { 0: items }, 1);
  assert.deepEqual(res[0].disclosureSessionsSkipped, []);
  assert.equal(res[0].sessionsCaptured, 12);
});

test('copy-day: an unknown stream item type throws', async () => {
  r = rig();
  await assert.rejects(
    runDays(r, { 0: [{ type: 'bogus', id: 'x', day: 0, minute: 1 } as never] }, 1),
    /unknown stream item type: bogus/,
  );
});

test('copy-day: a wrong head gets a correction row and a correction-believe route', {
  timeout: 120_000,
}, async () => {
  r = rig();
  const day0 = [
    callItem(
      'c-a',
      0,
      600,
      'believe',
      'wrong-value',
      'amber-mesa-trip',
      'amber mesa trip',
      'dropped',
    ),
  ];
  const day1 = [
    callItem(
      'c-b',
      1,
      600,
      'record_correction',
      'correct',
      'amber-mesa-trip',
      'amber mesa trip',
      'booked',
    ),
  ];
  await runDays(r, { 0: day0, 1: day1 }, 2);
  const n = (
    r.db.prepare(`SELECT COUNT(*) n FROM corrections WHERE topic = 'amber-mesa-trip'`).get() as {
      n: number;
    }
  ).n;
  assert.equal(n, 1);
  assert.ok([...r.routes.all().values()].includes('correction-believe'));
  assert.match(
    (recallBelief(r.db, { topic: 'amber-mesa-trip' }) as { claim: string }).claim,
    /booked/,
  );
});

test('copy-day: a 9-day template run hits no unhandled prompts', { timeout: 120_000 }, async () => {
  r = rig();
  const s = generateScript(paramsWith({ horizonDays: 9 }), 41);
  s.probes = generateProbes(s);
  const res = await runDays(r, groupByDay(renderTemplate(s)), 9);
  assert.deepEqual(res.at(-1)?.unhandledPrompts, []);
  assert.deepEqual(
    res.flatMap((d) => d.disclosureSessionsSkipped),
    [],
  );
  assert.deepEqual(
    res.flatMap((d) => d.disclosureSessionsUnextracted),
    [],
  );
});

test('copy-day: a disclosure session classified dev is reported as unextracted', async () => {
  r = rig();
  // First person keeps it out of the pure-dev skip; nine dev keywords make capture
  // classify it `dev`, which the biographer selector never extracts.
  const devTurn =
    'I am fixing the build today: the lint step, the schema migration, the deploy query, the endpoint refactor and the commit hook all broke.';
  const items = [
    sessionItem('s-dev-1', 0, 600, [
      stateSentence('heron marsh trip', 'booked', 'explicit'),
      devTurn,
    ]),
    sessionItem('s-ok-1', 0, 601, [stateSentence('slate ridge trip', 'planned', 'explicit')]),
  ];
  const res = await runDays(r, { 0: items }, 1);
  assert.equal(res[0].sessionsCaptured, 2);
  assert.deepEqual(res[0].disclosureSessionsSkipped, []);
  assert.deepEqual(res[0].disclosureSessionsUnextracted, ['s-dev-1']);
});

test('copy-day: an embedder failure is surfaced in errors', async () => {
  r = rig();
  r.db.exec('DROP TABLE events_vec');
  const items = [
    sessionItem('s-emb-1', 0, 600, [stateSentence('heron marsh trip', 'booked', 'explicit')]),
  ];
  const res = await runDays(r, { 0: items }, 1);
  assert.ok(
    res[0].errors.some((e) => /^embedder skipped: /.test(e)),
    JSON.stringify(res[0].errors),
  );
});

test('routes: the ledger is append-only and re-read on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-routes-'));
  try {
    const path = join(dir, 'routes.jsonl');
    const a = openRouteLedger(path);
    a.add(7, 'direct-believe');
    a.add(9, 'correction-believe');
    assert.deepEqual(
      [...openRouteLedger(path).all()],
      [
        [7, 'direct-believe'],
        [9, 'correction-believe'],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
