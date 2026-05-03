import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installRandom, uninstallRandom, seededRandomBytes } from '../ids.js';

describe('ids', () => {
  afterEach(() => uninstallRandom());

  it('Math.random produces deterministic sequence with same seed', () => {
    installRandom('seed-A');
    const a = [Math.random(), Math.random(), Math.random()];
    uninstallRandom();
    installRandom('seed-A');
    const b = [Math.random(), Math.random(), Math.random()];
    assert.deepEqual(a, b);
  });

  it('different seeds produce different sequences', () => {
    installRandom('seed-A');
    const a = Math.random();
    uninstallRandom();
    installRandom('seed-B');
    const b = Math.random();
    assert.notEqual(a, b);
  });

  it('crypto.randomUUID returns RFC v4-shaped string', () => {
    installRandom('seed-A');
    const id = crypto.randomUUID();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('crypto.randomUUID is deterministic', () => {
    installRandom('seed-A');
    const a = crypto.randomUUID();
    uninstallRandom();
    installRandom('seed-A');
    const b = crypto.randomUUID();
    assert.equal(a, b);
  });

  it('crypto.randomBytes returns Buffer of correct length', () => {
    installRandom('seed-A');
    const buf = seededRandomBytes(16);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.length, 16);
  });

  it('uninstallRandom restores Math.random', () => {
    installRandom('seed-A');
    uninstallRandom();
    const a = Math.random();
    const b = Math.random();
    // Real Math.random — virtually never equal.
    assert.notEqual(a, b);
  });
});
