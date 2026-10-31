import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  operatorName,
  readOperatorProfile,
  setOperatorProfileForTests,
} from './operator-profile.ts';

afterEach(() => setOperatorProfileForTests(null));

test('readOperatorProfile: reads name + context from config/operator.yaml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-operator-'));
  mkdirSync(join(dir, 'config'));
  writeFileSync(
    join(dir, 'config', 'operator.yaml'),
    'name: Quinn\ncontext: >-\n  Context: The user is Quinn,\n  a potter.\naliases: [quinnr, "  "]\nhome: { lat: 51.5, lng: -0.12, label: Camden }\n',
  );
  assert.deepEqual(readOperatorProfile(dir), {
    name: 'Quinn',
    context: 'Context: The user is Quinn, a potter.',
    aliases: ['quinnr'],
    privateTerms: [],
    home: { lat: 51.5, lng: -0.12, label: 'Camden' },
  });
});

test('readOperatorProfile: missing file or blank fields → generic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-operator-'));
  const none = { name: null, context: null, aliases: [], privateTerms: [], home: null };
  assert.deepEqual(readOperatorProfile(dir), none);
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config', 'operator.yaml'), 'name: "  "\nhome: { lat: 140, lng: 0 }\n');
  assert.deepEqual(readOperatorProfile(dir), none, 'blank name and out-of-range home are ignored');
});

test('operatorName: configured name, else the fallback', () => {
  setOperatorProfileForTests({
    name: 'Quinn',
    context: null,
    aliases: [],
    privateTerms: [],
    home: null,
  });
  assert.equal(operatorName(), 'Quinn');
  setOperatorProfileForTests({
    name: null,
    context: null,
    aliases: [],
    privateTerms: [],
    home: null,
  });
  assert.equal(operatorName(), 'the user');
  assert.equal(operatorName('operator'), 'operator');
});
