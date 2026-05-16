import assert from 'node:assert';
import { test } from 'node:test';
import { sync } from '../../io/integrations/github/sync.js';

function makeFetch(routes) {
  // Sort by descending pattern length so more-specific routes match before
  // shorter prefixes (e.g. '/users/octocat/events' before '/user').
  const sorted = [...routes].sort((a, b) => b[0].length - a[0].length);
  return async (url) => {
    for (const [pattern, body] of sorted) {
      if (url.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          async json() {
            return body;
          },
          async text() {
            return JSON.stringify(body);
          },
        };
      }
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return [];
      },
      async text() {
        return '[]';
      },
    };
  };
}

test('github sync captures one event per object kind', async () => {
  const captured = [];
  const ctx = {
    secrets: { GITHUB_PAT: 'pat_test' },
    fetchFn: makeFetch([
      ['/user', { login: 'octocat' }],
      [
        '/users/octocat/events',
        [
          {
            id: '1',
            type: 'PushEvent',
            repo: { name: 'r/x' },
            payload: { commits: [{}] },
            created_at: new Date().toISOString(),
          },
        ],
      ],
      [
        '/notifications',
        [
          {
            id: 'n1',
            subject: { type: 'PullRequest', title: 'fix bug' },
            repository: { full_name: 'r/x' },
            reason: 'review_requested',
            updated_at: new Date().toISOString(),
            unread: true,
          },
        ],
      ],
      ['/user/starred', []],
    ]),
    capture: async (events) => {
      captured.push(...events);
      return { count: events.length };
    },
    log: () => {},
    cursor: null,
    signal: undefined,
  };
  const out = await sync(ctx);
  assert.ok(out.count >= 2);
  const kinds = captured.map((e) => e.meta.kind);
  assert.ok(kinds.includes('github_activity'));
  assert.ok(kinds.includes('github_notif'));
});

test('github sync survives /notifications 403 (fine-grained PAT)', async () => {
  const ctx = {
    secrets: { GITHUB_PAT: 'pat_test' },
    fetchFn: async (url) => {
      if (url.includes('/user') && !url.includes('/users/'))
        return {
          ok: true,
          status: 200,
          async json() {
            return { login: 'kev' };
          },
        };
      if (url.includes('/users/kev/events'))
        return {
          ok: true,
          status: 200,
          async json() {
            return [];
          },
        };
      if (url.includes('/notifications'))
        return {
          ok: false,
          status: 403,
          async json() {
            return {};
          },
        };
      if (url.includes('/user/starred'))
        return {
          ok: true,
          status: 200,
          async json() {
            return [];
          },
        };
      return {
        ok: true,
        status: 200,
        async json() {
          return [];
        },
      };
    },
    capture: async () => ({ count: 0 }),
    log: () => {},
    cursor: null,
  };
  const out = await sync(ctx);
  assert.equal(out.count, 0); // notifications skipped, others empty
});
