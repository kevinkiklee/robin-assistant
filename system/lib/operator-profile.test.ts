import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  operatorName,
  operatorTimeZone,
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

test('operatorTimeZone: operator.yaml zone, then ROBIN_TZ, then the host; bad zones skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-operator-'));
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config', 'operator.yaml'), 'timezone: Europe/Lisbon\n');
  assert.equal(readOperatorProfile(dir).timezone, 'Europe/Lisbon');
  writeFileSync(join(dir, 'config', 'operator.yaml'), 'timezone: Mars/Olympus\n');
  assert.equal(readOperatorProfile(dir).timezone, undefined, 'an invalid zone is dropped');

  const saved = process.env.ROBIN_TZ;
  try {
    setOperatorProfileForTests({ ...readOperatorProfile(dir), timezone: 'Asia/Tokyo' });
    process.env.ROBIN_TZ = 'Africa/Nairobi';
    assert.equal(operatorTimeZone(), 'Asia/Tokyo', 'the profile wins');
    setOperatorProfileForTests(readOperatorProfile(dir));
    assert.equal(operatorTimeZone(), 'Africa/Nairobi', 'then ROBIN_TZ');
    process.env.ROBIN_TZ = 'Not/AZone';
    assert.equal(operatorTimeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  } finally {
    if (saved === undefined) delete process.env.ROBIN_TZ;
    else process.env.ROBIN_TZ = saved;
  }
});
