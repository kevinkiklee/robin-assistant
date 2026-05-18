import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  compileArgs,
  compileTemplate,
  compileTrigger,
  compileVarsResolver,
  compileWhen,
  loadTriggersFromDir,
} from '../../cognition/triggers/loader.js';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'robin-triggers-'));
}

test('compileWhen returns boolean predicate against event', () => {
  const fn = compileWhen('event.recovery < 50');
  assert.equal(fn({ event: { recovery: 40 } }), true);
  assert.equal(fn({ event: { recovery: 70 } }), false);
});

test('compileWhen supports $vars rewrite', () => {
  const fn = compileWhen('event.recovery < $vars.threshold');
  assert.equal(fn({ event: { recovery: 30 }, vars: { threshold: 50 } }), true);
});

test('compileWhen on parse error throws', () => {
  assert.throws(() => compileWhen('event.recovery <<< 50'));
});

test('compileWhen swallows runtime errors as false', () => {
  const fn = compileWhen('event.does.not.exist > 1');
  assert.equal(fn({ event: {} }), false);
});

test('compileTemplate interpolates event paths', () => {
  const t = compileTemplate('Recovery {event.recovery}%');
  assert.equal(t({ event: { recovery: 42 }, vars: {} }), 'Recovery 42%');
});

test('compileTemplate interpolates $vars paths', () => {
  const t = compileTemplate('was {$vars.prev}');
  assert.equal(t({ event: {}, vars: { prev: 80 } }), 'was 80');
});

test('compileTemplate leaves malformed placeholders literal', () => {
  const t = compileTemplate('weird {not a path} text');
  assert.equal(t({ event: {}, vars: {} }), 'weird {not a path} text');
});

test('compileTemplate returns "" for missing values', () => {
  const t = compileTemplate('hi {event.absent}!');
  assert.equal(t({ event: {}, vars: {} }), 'hi !');
});

test('compileArgs builds object with templates', () => {
  const fn = compileArgs({ title: '{event.kind}', body: 'static' });
  assert.deepEqual(fn({ event: { kind: 'alert' }, vars: {} }), { title: 'alert', body: 'static' });
});

test('compileArgs with non-object returns single value', () => {
  const fn = compileArgs('hello {event.who}');
  assert.equal(fn({ event: { who: 'world' }, vars: {} }), 'hello world');
});

test('compileVarsResolver runs each query and returns scalars', async () => {
  const db = {
    query: (q) => ({
      collect: async () => {
        if (q === 'SELECT 1') return [[1]];
        if (q === 'SELECT 99') return [[99]];
        return [[]];
      },
    }),
  };
  const fn = compileVarsResolver({ a: 'SELECT 1', b: 'SELECT 99' }, { db });
  const vars = await fn();
  assert.deepEqual(vars, { a: 1, b: 99 });
});

test('compileVarsResolver returns null for failed queries', async () => {
  const db = {
    query: () => ({
      collect: async () => {
        throw new Error('db down');
      },
    }),
  };
  const fn = compileVarsResolver({ x: 'SELECT 1' }, { db });
  const vars = await fn();
  assert.equal(vars.x, null);
});

test('compileTrigger requires name, on, do[]', () => {
  assert.throws(() => compileTrigger({}), /name required/);
  assert.throws(() => compileTrigger({ name: 'x' }), /on required/);
  assert.throws(() => compileTrigger({ name: 'x', on: 'whoop' }), /do/);
});

test('compileTrigger produces runnable trigger', async () => {
  const _stubDb = { query: () => ({ collect: async () => [[]] }) };
  const trig = compileTrigger(
    {
      name: 'low',
      on: 'whoop',
      cooldown_ms: 60_000,
      vars: { threshold: 'SELECT 50' },
      when: 'event.recovery < $vars.threshold',
      do: [{ tool: 'macos_notify', args: { title: 'Recovery {event.recovery}%' } }],
    },
    { db: { query: (_q) => ({ collect: async () => [[50]] }) } },
  );
  assert.equal(trig.name, 'low');
  assert.equal(trig.on, 'whoop');
  assert.equal(trig.cooldownMs, 60_000);
  // When predicate awaits vars + evaluates.
  assert.equal(await trig.when({ event: { recovery: 30 } }), true);
  assert.equal(await trig.when({ event: { recovery: 70 } }), false);
  // Action args function awaits vars + interpolates.
  const args = await trig.do[0].args({ event: { recovery: 30 } });
  assert.deepEqual(args, { title: 'Recovery 30%' });
});

test('loadTriggersFromDir reads .yaml files and surfaces parse errors', () => {
  const dir = makeDir();
  writeFileSync(
    join(dir, 'good.yaml'),
    'name: g1\non: whoop\ndo:\n  - tool: macos_notify\n    args:\n      title: hi\n',
  );
  writeFileSync(join(dir, 'bad.yaml'), '\tnot: valid yaml: : :\n');
  writeFileSync(join(dir, 'ignore.txt'), 'not a yaml');
  const stubDb = { query: () => ({ collect: async () => [[]] }) };
  const { triggers, errors } = loadTriggersFromDir(dir, { db: stubDb });
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].name, 'g1');
  assert.equal(errors.length, 1);
  assert.match(errors[0].path, /bad\.yaml$/);
});

test('loadTriggersFromDir returns empty when dir missing', () => {
  const r = loadTriggersFromDir('/tmp/__nope__', { db: null });
  assert.deepEqual(r, { triggers: [], errors: [] });
});
