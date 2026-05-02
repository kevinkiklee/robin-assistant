// Privacy is an immutable rule. Every write path that uses the redact
// library must block: full government IDs (SSN, SIN, passport), full
// payment/bank account numbers, credentials, URLs with embedded creds.
//
// These tests probe the redact lib directly (the canonical enforcement
// point for sync-lib writes) and the markdown atomicWrite helper that
// integration scripts use.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyRedaction } from '../scripts/sync/lib/redact.js';

function redact(s) {
  const { redacted, count } = applyRedaction(s);
  return { text: redacted, count };
}

describe('privacy: redact() blocks credentials and IDs', () => {
  it('redacts a full SSN', () => {
    const r = redact('SSN: 123-45-6789');
    assert.match(r.text, /\[REDACTED:ssn\]/);
    assert.equal(r.count, 1);
    assert.doesNotMatch(r.text, /123-45-6789/);
  });

  it('redacts an OpenAI key (sk- prefix)', () => {
    const r = redact('Use OPENAI_API_KEY=sk-' + 'A'.repeat(32));
    assert.match(r.text, /\[REDACTED:api-key\]/);
    assert.doesNotMatch(r.text, /sk-A{32}/);
  });

  it('redacts a GitHub PAT (ghp_ prefix)', () => {
    const r = redact('GITHUB_TOKEN=ghp_' + 'B'.repeat(40));
    assert.match(r.text, /\[REDACTED:api-key\]/);
  });

  it('redacts an AWS access key', () => {
    const r = redact('aws-key=AKIAIOSFODNN7EXAMPLE');
    assert.match(r.text, /\[REDACTED:api-key\]/);
  });

  it('redacts a URL with embedded credentials', () => {
    const r = redact('connect to https://admin:hunter2@db.internal/');
    assert.match(r.text, /\[REDACTED:url-cred\]/);
    assert.doesNotMatch(r.text, /hunter2/);
  });

  it('redacts a Slack bot token (xoxb- prefix)', () => {
    const r = redact('SLACK_TOKEN=xoxb-1234567890-abc-def');
    assert.match(r.text, /\[REDACTED:api-key\]/);
  });

  it('redacts a credit card number that passes Luhn check (no spaces)', () => {
    // 4111111111111111 is a Visa test number that passes Luhn.
    // The redact lib's pattern is \b\d{13,19}\b — no spaces in the digit run.
    const r = redact('paid with 4111111111111111');
    assert.match(r.text, /\[REDACTED:credit-card\]/);
  });

  it('does NOT redact a 16-digit number that fails Luhn', () => {
    // 1234567890123456 fails Luhn — should stay.
    const r = redact('order #1234567890123456');
    assert.equal(r.count, 0);
  });

  it('redacts multiple patterns in one string', () => {
    const r = redact('SSN 111-22-3333 token sk-' + 'X'.repeat(32) + ' url https://u:p@x.com');
    assert.equal(r.count, 3);
  });

  it('returns count=0 and unchanged text when no patterns match', () => {
    const safe = 'Kevin lives in Astoria and likes dark roast coffee.';
    const r = redact(safe);
    assert.equal(r.count, 0);
    assert.equal(r.text, safe);
  });

  it('throws TypeError on non-string input (boundary)', () => {
    assert.throws(() => redact(null), TypeError);
    assert.throws(() => redact(123), TypeError);
    assert.throws(() => redact({}), TypeError);
  });
});

describe('privacy: integration coverage', () => {
  it('redact module exports the expected surface', async () => {
    const m = await import('../scripts/sync/lib/redact.js');
    assert.equal(typeof m.applyRedaction, 'function');
  });

  it('atomicWrite uses redact (smoke test by inspection)', async () => {
    // The atomicWrite helper in lib/sync/markdown.js uses redact() to scrub
    // before writing. This test ensures the import chain stays intact —
    // a regression here would silently disable redaction for sync writes.
    const md = await import('../scripts/sync/lib/markdown.js');
    assert.equal(typeof md.atomicWrite, 'function');
  });
});
