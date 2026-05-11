import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { buildEventFromIssue, priorityLabelFor } from '../../io/integrations/linear/client.js';
import { sync } from '../../io/integrations/linear/sync.js';

test('priorityLabelFor maps numeric Linear priorities', () => {
  assert.equal(priorityLabelFor(1), 'Urgent');
  assert.equal(priorityLabelFor(3), 'Medium');
  assert.equal(priorityLabelFor(0), 'No priority');
  assert.equal(priorityLabelFor(undefined), 'No priority');
});

test('buildEventFromIssue shapes content + meta', () => {
  const issue = {
    id: 'iss_123',
    identifier: 'ENG-42',
    title: 'Wire up the new dashboard',
    priority: 2,
    state: { name: 'In Progress', type: 'started' },
    assignee: { name: 'Kevin' },
    team: { id: 't1', key: 'ENG', name: 'Engineering' },
    project: { id: 'p1', name: 'Q2 Planning' },
    cycle: { id: 'c1', number: 7, name: 'Cycle 7' },
    url: 'https://linear.app/x/ENG-42',
    updatedAt: '2026-05-09T15:00:00Z',
    dueDate: '2026-05-15',
  };
  const e = buildEventFromIssue(issue);
  assert.equal(e.source, 'linear');
  assert.equal(e.external_id, 'linear:ENG-42');
  assert.match(e.content, /In Progress/);
  assert.match(e.content, /High/);
  assert.match(e.content, /Wire up the new dashboard/);
  assert.equal(e.meta.identifier, 'ENG-42');
  assert.equal(e.meta.team, 'ENG');
  assert.equal(e.meta.cycle, 'Cycle 7');
});

test('linear sync sends Authorization header without Bearer prefix', async () => {
  const calls = [];
  const fetchFn = mock.fn(async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({
        data: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'i1',
                identifier: 'ENG-1',
                title: 'Issue 1',
                priority: 3,
                state: { name: 'Todo', type: 'unstarted' },
                team: { id: 't1', key: 'ENG', name: 'Engineering' },
                updatedAt: '2026-05-09T15:00:00Z',
              },
            ],
          },
        },
      }),
    };
  });
  const captured = [];
  const r = await sync({
    secrets: { LINEAR_API_KEY: 'lin_api_xxx' },
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 1);
  assert.equal(captured[0].external_id, 'linear:ENG-1');
  assert.equal(calls[0].opts.headers.Authorization, 'lin_api_xxx');
  assert.match(r.cursor.updated_after, /^2026-05-09T15:00:00Z$/);
});

test('linear sync paginates up to cap across multiple pages', async () => {
  let page = 0;
  const fetchFn = mock.fn(async () => {
    page += 1;
    const hasMore = page < 2;
    return {
      ok: true,
      json: async () => ({
        data: {
          issues: {
            pageInfo: { hasNextPage: hasMore, endCursor: hasMore ? 'c1' : null },
            nodes: [
              {
                id: `i${page}`,
                identifier: `ENG-${page}`,
                title: `Issue ${page}`,
                priority: 3,
                state: { name: 'Todo', type: 'unstarted' },
                team: { id: 't1', key: 'ENG', name: 'Engineering' },
                updatedAt: `2026-05-0${page}T15:00:00Z`,
              },
            ],
          },
        },
      }),
    };
  });
  const captured = [];
  const r = await sync({
    secrets: { LINEAR_API_KEY: 'k' },
    log: () => {},
    cursor: { updated_after: '2026-05-01T00:00:00Z' },
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 2);
  assert.equal(page, 2);
});
