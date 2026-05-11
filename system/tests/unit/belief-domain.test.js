import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferDomain } from '../../cognition/belief/domain.js';

const CFG = { domain_entity_types: ['topic', 'project', 'library'] };

test('inferDomain: explicit caller domain wins', () => {
  const r = inferDomain('anything', 'photography', [], CFG);
  assert.equal(r.domain, 'photography');
  assert.equal(r.source, 'explicit');
});

test('inferDomain: single catalog match -> lowercase domain', () => {
  const catalog = [{ name: 'GFX', type: 'topic' }];
  const r = inferDomain('specs of the GFX 100', null, catalog, CFG);
  assert.equal(r.domain, 'gfx');
  assert.equal(r.telemetry, null);
});

test('inferDomain: multiple matches -> ambiguous (domain=null)', () => {
  const catalog = [
    { name: 'photography', type: 'topic' },
    { name: 'fujifilm', type: 'topic' },
  ];
  const r = inferDomain('photography and fujifilm', null, catalog, CFG);
  assert.equal(r.domain, null);
  assert.equal(r.telemetry, 'ambiguous');
});

test('inferDomain: no overlap -> none', () => {
  const catalog = [{ name: 'photography', type: 'topic' }];
  const r = inferDomain('f-stop of the camera body', null, catalog, CFG);
  assert.equal(r.domain, null);
  assert.equal(r.telemetry, 'none');
});

test('inferDomain: entity-type filter excludes person/place', () => {
  const catalog = [
    { name: 'kevin', type: 'person' },
    { name: 'photography', type: 'topic' },
  ];
  const r = inferDomain('what kevin said about photography', null, catalog, CFG);
  assert.equal(r.domain, 'photography');
});
