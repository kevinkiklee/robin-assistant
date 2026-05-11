import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from '../../runtime/daemon/schema.js';

test('accepts a body matching the schema', () => {
  const r = validate({ name: 'x', force: true }, { name: 'string', force: 'boolean?' });
  assert.deepEqual(r, { ok: true, value: { name: 'x', force: true } });
});

test('optional field may be omitted', () => {
  const r = validate({ name: 'x' }, { name: 'string', force: 'boolean?' });
  assert.equal(r.ok, true);
});

test('rejects missing required field', () => {
  const r = validate({}, { name: 'string' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'name' && /required/.test(e.message)));
});

test('rejects wrong type', () => {
  const r = validate({ name: 123 }, { name: 'string' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'name'));
});

test('rejects unknown fields (strict)', () => {
  const r = validate({ name: 'x', extra: 'nope' }, { name: 'string' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'extra' && /unknown/i.test(e.message)));
});

test('integer rejects non-integer numbers', () => {
  const r = validate({ n: 1.5 }, { n: 'integer' });
  assert.equal(r.ok, false);
});

test('array accepts arrays', () => {
  const r = validate({ items: [1, 2] }, { items: 'array' });
  assert.equal(r.ok, true);
});

test('object accepts plain objects, rejects arrays and null', () => {
  assert.equal(validate({ meta: { a: 1 } }, { meta: 'object' }).ok, true);
  assert.equal(validate({ meta: [1, 2] }, { meta: 'object' }).ok, false);
  // Explicit null is a present-but-wrong-type value (not "absent").
  assert.equal(validate({ meta: null }, { meta: 'object?' }).ok, false);
  // Truly absent (key omitted) passes when optional.
  assert.equal(validate({}, { meta: 'object?' }).ok, true);
});

test('all-optional schema accepts empty body', () => {
  const r = validate({}, { x: 'string?', y: 'number?' });
  assert.equal(r.ok, true);
});

test('vocabulary tabulation — accepts every documented type', () => {
  const samples = {
    string: 'x',
    'string?': 'x',
    number: 1,
    'number?': 1,
    integer: 1,
    'integer?': 1,
    boolean: true,
    'boolean?': false,
    array: [],
    'array?': [],
    object: {},
    'object?': {},
  };
  for (const [type, sample] of Object.entries(samples)) {
    const r = validate({ v: sample }, { v: type });
    assert.equal(r.ok, true, `${type} should accept ${JSON.stringify(sample)}`);
  }
});

test('rejects non-object body', () => {
  assert.equal(validate(null, { name: 'string' }).ok, false);
  assert.equal(validate([], { name: 'string' }).ok, false);
  assert.equal(validate('x', { name: 'string' }).ok, false);
});
