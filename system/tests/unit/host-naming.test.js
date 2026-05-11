import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectHost } from '../../runtime/hosts/detect.js';
import { HOST_VALUES, HOSTS } from '../../runtime/hosts/index.js';

test('HOSTS exposes hyphenated canonical names', () => {
  assert.equal(HOSTS.CLAUDE_CODE, 'claude-code');
  assert.equal(HOSTS.GEMINI_CLI, 'gemini-cli');
  assert.equal(HOSTS.UNKNOWN, 'unknown');
});

test('HOST_VALUES contains the three canonical values', () => {
  assert.deepEqual([...HOST_VALUES].sort(), ['claude-code', 'gemini-cli', 'unknown']);
});

test('ROBIN_HOST=claude-code (hyphenated) resolves the claude-code adapter', async () => {
  const prev = process.env.ROBIN_HOST;
  process.env.ROBIN_HOST = 'claude-code';
  try {
    const host = await detectHost({ skipAvailabilityCheck: true });
    assert.equal(host.name, 'claude-code');
  } finally {
    if (prev === undefined) delete process.env.ROBIN_HOST;
    else process.env.ROBIN_HOST = prev;
  }
});

test('ROBIN_HOST=gemini-cli (hyphenated) resolves the gemini adapter', async () => {
  const prev = process.env.ROBIN_HOST;
  process.env.ROBIN_HOST = 'gemini-cli';
  try {
    const host = await detectHost({ skipAvailabilityCheck: true });
    assert.equal(host.name, 'gemini-cli');
  } finally {
    if (prev === undefined) delete process.env.ROBIN_HOST;
    else process.env.ROBIN_HOST = prev;
  }
});

test('ROBIN_HOST=claude_code (underscored) still works and warns once', async () => {
  const prev = process.env.ROBIN_HOST;
  process.env.ROBIN_HOST = 'claude_code';
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const host = await detectHost({ skipAvailabilityCheck: true });
    assert.equal(host.name, 'claude-code');
    assert.ok(
      warnings.some((w) => /deprecated|hyphen/i.test(w)),
      `expected deprecation warning, got: ${warnings.join('; ')}`,
    );
  } finally {
    console.warn = origWarn;
    if (prev === undefined) delete process.env.ROBIN_HOST;
    else process.env.ROBIN_HOST = prev;
  }
});

test('HOST_VALUES matches what registerSession will accept', () => {
  // Documents the contract: HOST_VALUES is the list registerSession accepts.
  // Verified in daemon/sessions.js via HOST_VALUES.includes(host) check.
  assert.ok(HOST_VALUES.includes('claude-code'));
  assert.ok(HOST_VALUES.includes('gemini-cli'));
  assert.ok(HOST_VALUES.includes('unknown'));
});
