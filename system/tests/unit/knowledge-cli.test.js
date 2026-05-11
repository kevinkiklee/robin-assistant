import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const { ingestCmd } = await import('../../src/cli/commands/ingest.js');
const { lintCmd } = await import('../../src/cli/commands/lint.js');
const { auditCmd } = await import('../../src/cli/commands/audit.js');

function capture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('ingest CLI — content arg POSTs content', async () => {
  const out = capture();
  let posted;
  await ingestCmd(['hello world'], {
    out: out.fn,
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return {
        ok: true,
        event_id: 'evt:1',
        entities_created: 0,
        edges_created: 0,
        knowledge_created: 0,
      };
    },
  });
  assert.equal(posted.path, '/internal/knowledge/ingest');
  assert.equal(posted.body.content, 'hello world');
});

test('ingest CLI — --url passes url', async () => {
  let posted;
  await ingestCmd(['--url', 'https://example.com/x'], {
    out: () => {},
    daemonRequest: async (_path, body) => {
      posted = body;
      return { ok: true };
    },
  });
  assert.equal(posted.url, 'https://example.com/x');
});

test('ingest CLI — --file passes file_path', async () => {
  let posted;
  await ingestCmd(['--file', '/tmp/x.md'], {
    out: () => {},
    daemonRequest: async (_path, body) => {
      posted = body;
      return { ok: true };
    },
  });
  assert.equal(posted.file_path, '/tmp/x.md');
});

test('lint CLI — POSTs limit', async () => {
  const out = capture();
  let posted;
  await lintCmd(['--limit', '5'], {
    out: out.fn,
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true, issues: [], total: 0, returned: 0 };
    },
  });
  assert.equal(posted.path, '/internal/knowledge/lint');
  assert.equal(posted.body.limit, 5);
});

test('audit CLI — POSTs pair_count', async () => {
  let posted;
  await auditCmd(['--pairs', '4'], {
    out: () => {},
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true, pairs_checked: 0, contradictions: [] };
    },
  });
  assert.equal(posted.path, '/internal/knowledge/audit');
  assert.equal(posted.body.pair_count, 4);
});
