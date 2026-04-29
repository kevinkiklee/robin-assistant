import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRedaction } from '../../scripts/lib/sync/redact.js';

test('redacts US SSN', () => {
  const { redacted, count } = applyRedaction('My SSN is 123-45-6789.');
  assert.equal(redacted, 'My SSN is [REDACTED:ssn].');
  assert.equal(count, 1);
});

test('redacts Canadian SIN', () => {
  const { redacted, count } = applyRedaction('SIN: 123 456 789');
  assert.equal(redacted, 'SIN: [REDACTED:sin]');
  assert.equal(count, 1);
});

test('redacts a Luhn-valid 16-digit credit card', () => {
  const { redacted, count } = applyRedaction('Card 4111111111111111 charged.');
  assert.equal(redacted, 'Card [REDACTED:credit-card] charged.');
  assert.equal(count, 1);
});

test('does not redact a 16-digit non-Luhn number', () => {
  const { redacted, count } = applyRedaction('Order 1234567890123456 confirmed.');
  assert.equal(redacted, 'Order 1234567890123456 confirmed.');
  assert.equal(count, 0);
});

test('redacts OpenAI-style API keys (sk-…)', () => {
  const { redacted } = applyRedaction('OPENAI_API_KEY=sk-ABCdef123456ABCdef123456ABCdef12');
  assert.match(redacted, /\[REDACTED:api-key\]/);
});

test('redacts GitHub PATs (ghp_…)', () => {
  const { redacted } = applyRedaction('token=ghp_abcdefghijklmnopqrstuvwxyzABCDEF1234');
  assert.match(redacted, /\[REDACTED:api-key\]/);
});

test('redacts AWS access key IDs (AKIA…)', () => {
  const { redacted } = applyRedaction('AKIAIOSFODNN7EXAMPLE in logs');
  assert.match(redacted, /\[REDACTED:api-key\]/);
});

test('redacts credentials embedded in a URL', () => {
  const { redacted, count } = applyRedaction('curl https://user:pass@example.com/api');
  assert.equal(redacted, 'curl https://[REDACTED:url-cred]@example.com/api');
  assert.equal(count, 1);
});

test('returns the original string and count=0 when no patterns match', () => {
  const input = 'Plain text with no secrets.';
  const { redacted, count } = applyRedaction(input);
  assert.equal(redacted, input);
  assert.equal(count, 0);
});

test('counts multiple matches across pattern types', () => {
  const { count } = applyRedaction('SSN 111-22-3333 and key sk-ABCdef123456ABCdef123456ABCdef12');
  assert.equal(count, 2);
});
