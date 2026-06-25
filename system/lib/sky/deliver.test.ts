// system/lib/sky/deliver.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fireMatches } from './deliver.ts';
import type { Notification, RecipeMatch } from './types.ts';

const fakeDb = () => {
  const calls: string[] = [];
  return {
    calls,
    prepare: () => ({ get: () => undefined, run: (...a: unknown[]) => { calls.push(a.join(',')); return { changes: 1, lastInsertRowid: 1 }; }, all: () => [] }),
  } as any;
};

test('new match fires a notification and records an alert', async () => {
  const db = fakeDb();
  const sent: Notification[] = [];
  const m: RecipeMatch = { recipe: 'sunset_color', window: 'sunset', windowDate: '2026-06-25',
    title: '🌇 t', body: 'high cloud', key: 'sunset:2026-06-25', mergeGroup: 'sunset:2026-06-25' };
  const r = await fireMatches({ db, matches: [m], openKeys: [], deliver: async (n) => { sent.push(n); } });
  assert.deepEqual(r.fired, ['sunset:2026-06-25']);
  assert.equal(sent.length, 1);
});

test('open key absent from matches ⇒ silently resolved, no notification', async () => {
  const db = fakeDb();
  const sent: Notification[] = [];
  const r = await fireMatches({ db, matches: [], openKeys: ['sunset:2026-06-25'], deliver: async (n) => { sent.push(n); } });
  assert.deepEqual(r.resolved, ['sunset:2026-06-25']);
  assert.equal(sent.length, 0);
});

test('already-open key ⇒ no re-notification and fired is empty', async () => {
  const db = fakeDb();
  const sent: Notification[] = [];
  const m: RecipeMatch = { recipe: 'sunset_color', window: 'sunset', windowDate: '2026-06-25',
    title: '🌇 t', body: 'high cloud', key: 'sunset:2026-06-25', mergeGroup: 'sunset:2026-06-25' };
  const r = await fireMatches({ db, matches: [m], openKeys: ['sunset:2026-06-25'], deliver: async (n) => { sent.push(n); } });
  assert.deepEqual(r.fired, []);
  assert.equal(sent.length, 0);
});

test('two matches sharing a mergeGroup ⇒ exactly one notification, both keys in fired', async () => {
  const db = fakeDb();
  const sent: Notification[] = [];
  const color: RecipeMatch = { recipe: 'sunset_color', window: 'sunset', windowDate: '2026-06-25',
    title: '🌇 t', body: 'high cloud', key: 'sunset:2026-06-25', mergeGroup: 'sunset:2026-06-25' };
  const clearing: RecipeMatch = { recipe: 'rain_clearing', window: 'sunset', windowDate: '2026-06-25',
    title: '⛈️→☀️ t', body: 'storm breaking', key: 'clearing:2026-06-25', mergeGroup: 'sunset:2026-06-25' };
  const r = await fireMatches({ db, matches: [color, clearing], openKeys: [], deliver: async (n) => { sent.push(n); } });
  assert.deepEqual(r.fired.sort(), ['clearing:2026-06-25', 'sunset:2026-06-25']);
  assert.equal(sent.length, 1);
});
