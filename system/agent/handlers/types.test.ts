import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type HandlerCtx, type HandlerDef, REGISTRY, register } from './types.ts';

function fakeHandler(overrides: Partial<HandlerDef> = {}): HandlerDef {
  return {
    id: 'TEST',
    name: 'fake',
    trigger: 'on-demand',
    build: (goal, ctx) => ({
      goal,
      cwd: ctx.repoRoot,
      allowedTools: ['Read'],
      permissionMode: 'plan',
      maxTurns: 1,
      timeoutMs: 1000,
      maxBudgetUsd: 1,
    }),
    ...overrides,
  };
}

test('register + lookup: a registered handler is retrievable by id', () => {
  delete REGISTRY.TEST;
  const h = fakeHandler();
  register(h);
  assert.equal(REGISTRY.TEST, h);
  delete REGISTRY.TEST;
});

test('register: a duplicate id overwrites the prior entry', () => {
  delete REGISTRY.TEST;
  const first = fakeHandler({ name: 'first' });
  const second = fakeHandler({ name: 'second' });
  register(first);
  register(second);
  assert.equal(REGISTRY.TEST, second);
  assert.equal(REGISTRY.TEST.name, 'second');
  delete REGISTRY.TEST;
});

test('build(): returns the expected RunAgentInput shape (no surface)', () => {
  const ctx: HandlerCtx = { repoRoot: '/repo' };
  const out = fakeHandler().build('do a thing', ctx);
  assert.equal(out.goal, 'do a thing');
  assert.equal(out.cwd, '/repo');
  assert.deepEqual(out.allowedTools, ['Read']);
  assert.equal(out.permissionMode, 'plan');
  assert.equal(out.maxTurns, 1);
  assert.equal(out.timeoutMs, 1000);
  assert.equal(out.maxBudgetUsd, 1);
  // `surface` is intentionally omitted — the dispatcher supplies it.
  assert.equal('surface' in out, false);
});
