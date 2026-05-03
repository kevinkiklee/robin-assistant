import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { now, today, nowIso, installClock, uninstallClock } from './clock.js';

describe('clock', () => {
  afterEach(() => { uninstallClock(); delete process.env.ROBIN_CLOCK; });

  it('now() returns real time when ROBIN_CLOCK unset', () => {
    const t = now();
    assert.ok(Math.abs(t - Date.now()) < 100);
  });

  it('now() returns frozen time when ROBIN_CLOCK set', () => {
    process.env.ROBIN_CLOCK = '2026-05-02T12:00:00Z';
    assert.equal(now(), Date.parse('2026-05-02T12:00:00Z'));
  });

  it('today() formats YYYY-MM-DD from frozen clock', () => {
    process.env.ROBIN_CLOCK = '2026-05-02T12:00:00Z';
    assert.equal(today(), '2026-05-02');
  });

  it('nowIso() returns ISO from frozen clock', () => {
    process.env.ROBIN_CLOCK = '2026-05-02T12:00:00Z';
    assert.equal(nowIso(), '2026-05-02T12:00:00.000Z');
  });

  it('installClock patches Date.now and zero-arg new Date()', () => {
    installClock('2026-05-02T12:00:00Z');
    assert.equal(Date.now(), Date.parse('2026-05-02T12:00:00Z'));
    assert.equal(new Date().toISOString(), '2026-05-02T12:00:00.000Z');
  });

  it('installClock leaves new Date(arg) alone', () => {
    installClock('2026-05-02T12:00:00Z');
    assert.equal(new Date('2020-01-01T00:00:00Z').toISOString(), '2020-01-01T00:00:00.000Z');
    assert.equal(Date.parse('2020-01-01T00:00:00Z'), 1577836800000);
  });

  it('uninstallClock restores real Date.now', () => {
    installClock('2026-05-02T12:00:00Z');
    uninstallClock();
    assert.ok(Math.abs(Date.now() - new Date().getTime()) < 100);
  });
});
