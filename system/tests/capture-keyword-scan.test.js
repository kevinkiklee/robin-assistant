// system/tests/capture-keyword-scan.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier, scanKeywords } from '../scripts/lib/capture-keyword-scan.js';

describe('capture-keyword-scan', () => {
  it('tier 1 — fewer than 5 user words', () => {
    const r = classifyTier({ userMessage: 'thanks', entityAliases: [] });
    assert.equal(r.tier, 1);
    assert.equal(r.reason, 'short');
  });

  it('tier 1 — pure greeting', () => {
    const r = classifyTier({ userMessage: 'hey there', entityAliases: [] });
    assert.equal(r.tier, 1);
  });

  it('tier 2 — 5-19 words, no capture keywords', () => {
    const r = classifyTier({ userMessage: 'can you check the build status please', entityAliases: [] });
    assert.equal(r.tier, 2);
  });

  it('tier 3 — 20+ words', () => {
    const long = Array(25).fill('word').join(' ');
    const r = classifyTier({ userMessage: long, entityAliases: [] });
    assert.equal(r.tier, 3);
  });

  it('tier 3 — capture keyword present', () => {
    const r = classifyTier({ userMessage: 'remember my dentist is great', entityAliases: [] });
    assert.equal(r.tier, 3);
    assert.ok(r.keywords.includes('remember'));
  });

  it('tier 3 — date pattern', () => {
    const r = classifyTier({ userMessage: 'we leave on June 3rd next year', entityAliases: [] });
    assert.equal(r.tier, 3);
  });

  it('tier 3 — money amount', () => {
    const r = classifyTier({ userMessage: 'spent $1,200 on gear today', entityAliases: [] });
    assert.equal(r.tier, 3);
  });

  it('tier 3 — entity alias hit', () => {
    const r = classifyTier({ userMessage: 'meeting with dr. park tomorrow', entityAliases: ['Dr. Park'] });
    assert.equal(r.tier, 3);
    assert.ok(r.entitiesMatched.includes('Dr. Park'));
  });

  it('scanKeywords finds multiple matches', () => {
    const hits = scanKeywords('I decided to remember the meeting on Mar 5');
    assert.ok(hits.includes('decided'));
    assert.ok(hits.includes('remember'));
    assert.ok(hits.some((h) => /^date:/.test(h)));
  });
});
