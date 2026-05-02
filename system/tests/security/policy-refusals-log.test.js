import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPolicyRefusal, readRecentRefusalHashes, __test__ } from '../../scripts/lib/policy-refusals-log.js';

function ws() {
  return mkdtempSync(join(tmpdir(), 'policy-log-'));
}
function clean(p) {
  rmSync(p, { recursive: true, force: true });
}

test('appendPolicyRefusal: appends a TSV line with all fields', () => {
  const w = ws();
  try {
    appendPolicyRefusal(w, { kind: 'outbound', target: 'github:owner/repo', layer: '1', reason: 'taint', contentHash: 'abc12345' });
    const out = readFileSync(join(w, 'user-data/runtime/state/telemetry/policy-refusals.log'), 'utf-8');
    assert.match(out, /\toutbound\t/);
    assert.match(out, /\tgithub:owner\/repo\t/);
    assert.match(out, /\t1\t/);
    assert.match(out, /\ttaint\t/);
    assert.match(out, /\tabc12345\n/);
  } finally {
    clean(w);
  }
});

test('appendPolicyRefusal: tabs and newlines in fields are escaped', () => {
  const w = ws();
  try {
    appendPolicyRefusal(w, { kind: 'outbound', target: 't', layer: '1', reason: 'has\ttab\nnewline', contentHash: 'h' });
    const out = readFileSync(join(w, 'user-data/runtime/state/telemetry/policy-refusals.log'), 'utf-8');
    const fields = out.trim().split('\t');
    assert.equal(fields.length, 6);  // ts kind target layer reason hash
    assert.doesNotMatch(out, /tab\t/);  // escaped tab → space
  } finally {
    clean(w);
  }
});

test('appendPolicyRefusal: missing contentHash → empty field', () => {
  const w = ws();
  try {
    appendPolicyRefusal(w, { kind: 'tamper', target: 'hook', layer: 'severe', reason: 'x' });
    const out = readFileSync(join(w, 'user-data/runtime/state/telemetry/policy-refusals.log'), 'utf-8');
    assert.match(out, /\t\n$/, 'trailing tab + newline (empty hash)');
  } finally {
    clean(w);
  }
});

test('readRecentRefusalHashes: returns Set of recent hashes filtered by kind + window', () => {
  const w = ws();
  try {
    appendPolicyRefusal(w, { kind: 'outbound', target: 't1', layer: '1', reason: 'r1', contentHash: 'h1' });
    appendPolicyRefusal(w, { kind: 'bash', target: 't2', layer: '1', reason: 'r2', contentHash: 'h2' });
    appendPolicyRefusal(w, { kind: 'outbound', target: 't3', layer: '1', reason: 'r3', contentHash: 'h3' });

    const recent = readRecentRefusalHashes(w, 'outbound', 60_000);
    assert.equal(recent.has('h1'), true);
    assert.equal(recent.has('h2'), false);  // wrong kind
    assert.equal(recent.has('h3'), true);
  } finally {
    clean(w);
  }
});

test('readRecentRefusalHashes: window filter excludes old entries', () => {
  const w = ws();
  try {
    // Manually craft a log with an old timestamp.
    const path = __test__.logPath(w);
    mkdirSync(join(w, 'user-data/runtime/state/telemetry'), { recursive: true });
    writeFileSync(path, `2020-01-01T00:00:00.000Z\toutbound\tt\t1\tr\told_hash\n`);
    appendPolicyRefusal(w, { kind: 'outbound', target: 't', layer: '1', reason: 'r', contentHash: 'fresh_hash' });

    const recent = readRecentRefusalHashes(w, 'outbound', 60_000);
    assert.equal(recent.has('old_hash'), false);
    assert.equal(recent.has('fresh_hash'), true);
  } finally {
    clean(w);
  }
});

test('readRecentRefusalHashes: missing log returns empty Set', () => {
  const w = ws();
  try {
    const recent = readRecentRefusalHashes(w, 'outbound', 60_000);
    assert.equal(recent.size, 0);
  } finally {
    clean(w);
  }
});

test('rotateIfLarge: rotates log past threshold', () => {
  const w = ws();
  try {
    const path = __test__.logPath(w);
    mkdirSync(join(w, 'user-data/runtime/state/telemetry'), { recursive: true });
    // Write a >1MB log starting in 2026-04.
    const oneLine = '2026-04-01T00:00:00.000Z\toutbound\tt\t1\tr\th\n';
    let content = '';
    while (content.length < __test__.ROTATE_BYTES + 100) content += oneLine;
    writeFileSync(path, content);

    appendPolicyRefusal(w, { kind: 'outbound', target: 't', layer: '1', reason: 'r', contentHash: 'h' });

    // Original file truncated/replaced; archive exists.
    const archive = join(w, 'user-data/runtime/state/telemetry/policy-refusals-2026-04.log');
    assert.equal(existsSync(archive), true);
    // Current log has just the new entry.
    const cur = readFileSync(path, 'utf-8');
    assert.equal(cur.split('\n').filter(Boolean).length, 1);
  } finally {
    clean(w);
  }
});
