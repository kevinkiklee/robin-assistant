// get-knowledge-wrap.test.js — verify derived_from_trust wrapping in get_knowledge handler.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGetKnowledgeTool } from '../../io/mcp/tools/get-knowledge.js';

function makeDb(rows) {
  return {
    query() {
      return {
        async collect() {
          return [rows];
        },
      };
    },
  };
}

const embedder = {
  async embed() {
    return new Float32Array(1024);
  },
};

const TRUSTED_MEMO = {
  id: 'memos:t1',
  content: 'trusted content',
  confidence: 0.9,
  derived_from_trust: 'trusted',
  created_at: '2026-01-01T00:00:00.000Z',
};

const UNTRUSTED_MEMO = {
  id: 'memos:u1',
  content: 'untrusted content',
  confidence: 0.8,
  derived_from_trust: 'untrusted',
  created_at: '2026-01-01T00:00:00.000Z',
};

test('get_knowledge: trusted memo body passes through unchanged', async () => {
  const tool = createGetKnowledgeTool({ db: makeDb([TRUSTED_MEMO]), embedder });
  const r = await tool.handler({});
  assert.equal(r.knowledge.length, 1);
  assert.equal(r.knowledge[0].body, 'trusted content');
});

test('get_knowledge: untrusted memo body is wrapped with untrusted-content tag', async () => {
  const tool = createGetKnowledgeTool({ db: makeDb([UNTRUSTED_MEMO]), embedder });
  const r = await tool.handler({});
  assert.equal(r.knowledge.length, 1);
  const body = r.knowledge[0].body;
  assert.match(body, /<untrusted-content /);
  assert.ok(body.includes('untrusted content'), 'original content preserved inside wrapper');
  assert.match(body, /source="knowledge"/);
});

test('get_knowledge: mixed batch wraps only untrusted', async () => {
  const tool = createGetKnowledgeTool({ db: makeDb([TRUSTED_MEMO, UNTRUSTED_MEMO]), embedder });
  const r = await tool.handler({});
  assert.equal(r.knowledge.length, 2);
  // First is trusted — no wrapper tag
  assert.doesNotMatch(r.knowledge[0].body, /<untrusted-content /);
  assert.equal(r.knowledge[0].body, 'trusted content');
  // Second is untrusted — wrapped
  assert.match(r.knowledge[1].body, /<untrusted-content /);
});

test('get_knowledge: memo with no derived_from_trust passes through unchanged', async () => {
  const noTrustMemo = { id: 'memos:n1', content: 'neutral content', confidence: 0.7 };
  const tool = createGetKnowledgeTool({ db: makeDb([noTrustMemo]), embedder });
  const r = await tool.handler({});
  assert.equal(r.knowledge[0].body, 'neutral content');
});
