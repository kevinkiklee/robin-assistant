// tests/unit/predictions-cli.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { predictionsList } = await import('../../runtime/cli/commands/predictions-list.js');
const { predictionsResolve } = await import('../../runtime/cli/commands/predictions-resolve.js');

function capture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('predictions list — empty returns (no predictions)', async () => {
  const out = capture();
  await predictionsList([], {
    out: out.fn,
    listAllPredictions: async () => [],
  });
  assert.match(out.lines.join('\n'), /no predictions/);
});

test('predictions list — formats rows', async () => {
  const out = capture();
  await predictionsList([], {
    out: out.fn,
    listAllPredictions: async () => [
      {
        id: 'abc-123',
        kind: 'task_duration',
        confidence: 0.8,
        statement: 'This will take 2 hours',
        resolved_at: null,
        correct: null,
      },
    ],
  });
  const all = out.lines.join('\n');
  assert.match(all, /abc-123/);
  assert.match(all, /task_duration/);
  assert.match(all, /OPEN/);
  assert.match(all, /0\.8/);
  assert.match(all, /This will take 2 hours/);
});

test('predictions list --kind X passes filter to list helper', async () => {
  let receivedFilter;
  const out = capture();
  await predictionsList(['--kind', 'task_duration'], {
    out: out.fn,
    listAllPredictions: async (filter) => {
      receivedFilter = filter;
      return [];
    },
  });
  assert.equal(receivedFilter.kind, 'task_duration');
});

test('predictions list --resolved passes {resolved: true}', async () => {
  let receivedFilter;
  const out = capture();
  await predictionsList(['--resolved'], {
    out: out.fn,
    listAllPredictions: async (filter) => {
      receivedFilter = filter;
      return [];
    },
  });
  assert.equal(receivedFilter.resolved, true);
});

test('predictions resolve POSTs correct payload to /internal/predictions/resolve', async () => {
  const out = capture();
  const err = capture();
  let postedPath;
  let postedBody;
  await predictionsResolve(['foo', 'correct', 'took', '2h'], {
    out: out.fn,
    err: err.fn,
    daemonRequest: async (path, body) => {
      postedPath = path;
      postedBody = body;
      return { ok: true };
    },
  });
  assert.equal(postedPath, '/internal/predictions/resolve');
  assert.equal(postedBody.id, 'foo');
  assert.equal(postedBody.correct, true);
  assert.equal(postedBody.actual_outcome, 'took 2h');
  assert.match(out.lines.join('\n'), /resolved foo as correct/);
});
