import assert from 'node:assert/strict';
import test from 'node:test';
import { radio } from '../../src/cli/prompts.js';

function fakeInput(answers) {
  let i = 0;
  return async () => answers[i++];
}

test('radio: default returned on empty input', async () => {
  const r = await radio({
    question: 'Pick',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    defaultIndex: 1,
    inputFn: fakeInput(['']),
  });
  assert.strictEqual(r, 'b');
});

test('radio: numeric selection', async () => {
  const r = await radio({
    question: 'Pick',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    defaultIndex: 0,
    inputFn: fakeInput(['2']),
  });
  assert.strictEqual(r, 'b');
});

test('radio: invalid then valid input reprompts', async () => {
  const r = await radio({
    question: 'Pick',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    defaultIndex: 0,
    inputFn: fakeInput(['z', '99', '1']),
  });
  assert.strictEqual(r, 'a');
});

test('radio: custom path option triggers customFn when picked', async () => {
  const r = await radio({
    question: 'Pick',
    options: [
      { value: 'a', label: 'A' },
      { value: '__custom__', label: 'Custom…', customFn: async () => '/my/path' },
    ],
    defaultIndex: 0,
    inputFn: fakeInput(['2']),
  });
  assert.strictEqual(r, '/my/path');
});
