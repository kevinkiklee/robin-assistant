// tests/unit/commstyle-cli.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../config/paths.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const { commstyleShow } = await import('../../runtime/cli/commands/commstyle-show.js');
const { commstyleRefresh } = await import('../../runtime/cli/commands/commstyle-refresh.js');

function capture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('commstyle show — null prints "(not synthesized)"', async () => {
  const out = capture();
  await commstyleShow([], { out: out.fn, getCommStyle: async () => null });
  assert.match(out.lines.join('\n'), /not synthesized/);
});

test('commstyle show — prints all fields when populated', async () => {
  const out = capture();
  await commstyleShow([], {
    out: out.fn,
    getCommStyle: async () => ({
      tone: 'terse',
      formality: 'casual',
      emoji_ok: false,
      direct_feedback_ok: true,
      code_comment_density: 'minimal',
      summary_style: 'bullets',
      evidence: ['e1', 'e2'],
      confidence: 0.7,
      last_synthesized_at: new Date('2026-05-10T04:00:00Z'),
    }),
  });
  const all = out.lines.join('\n');
  assert.match(all, /tone: terse/);
  assert.match(all, /confidence: 0\.7/);
});

test('commstyle refresh — POSTs to /internal/comm-style/refresh', async () => {
  const out = capture();
  let posted;
  await commstyleRefresh([], {
    out: out.fn,
    daemonRequest: async (path) => {
      posted = path;
      return { ok: true, signals_used: 5, comm_style: { tone: 'terse', confidence: 0.7 } };
    },
  });
  assert.equal(posted, '/internal/comm-style/refresh');
  assert.match(out.lines.join('\n'), /ok/);
});
