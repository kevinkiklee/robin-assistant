import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorizeFailure,
  shouldNotify,
  recordNotification,
  clearDedupForJob,
  notificationText,
} from '../../../scripts/lib/jobs/categorize.js';

describe('categorizeFailure', () => {
  test('exit 0 → null', () => {
    assert.equal(categorizeFailure({ exitCode: 0 }), null);
  });

  test('exit 127 → command_not_found', () => {
    assert.equal(categorizeFailure({ exitCode: 127 }), 'command_not_found');
  });

  test('stderr "command not found" → command_not_found', () => {
    assert.equal(
      categorizeFailure({ exitCode: 1, stderrTail: 'sh: claude: command not found' }),
      'command_not_found'
    );
  });

  test('stderr 401 Unauthorized → auth_expired', () => {
    assert.equal(
      categorizeFailure({ exitCode: 1, stderrTail: 'HTTP 401 Unauthorized: token expired' }),
      'auth_expired'
    );
  });

  test('stderr "session expired" → auth_expired', () => {
    assert.equal(
      categorizeFailure({ exitCode: 1, stderrTail: 'Your session expired. Please log in.' }),
      'auth_expired'
    );
  });

  test('signal SIGTERM → timeout', () => {
    assert.equal(categorizeFailure({ signal: 'SIGTERM' }), 'timeout');
  });

  test('exit 2 → definition_invalid', () => {
    assert.equal(categorizeFailure({ exitCode: 2 }), 'definition_invalid');
  });

  test('exit 3 → internal', () => {
    assert.equal(categorizeFailure({ exitCode: 3 }), 'internal');
  });

  test('exit 1 with no signature → runtime_error', () => {
    assert.equal(categorizeFailure({ exitCode: 1, stderrTail: 'oops' }), 'runtime_error');
  });

  test('does not falsely match auth on success path stderr', () => {
    // Stderr from a successful run that mentions 401 in text — exit 0 short-circuits.
    assert.equal(categorizeFailure({ exitCode: 0, stderrTail: 'fyi we got a 401 earlier' }), null);
  });
});

describe('shouldNotify (dedup)', () => {
  const now = new Date('2026-04-29T04:00:14Z').getTime();

  test('first failure after success → notify', () => {
    assert.equal(shouldNotify({ jobName: 'dream', category: 'runtime_error', state: {}, now }), true);
  });

  test('same (job, category) repeat → suppress', () => {
    const state = {
      last_notified: { 'dream:runtime_error': new Date(now - 1000).toISOString() },
    };
    assert.equal(shouldNotify({ jobName: 'dream', category: 'runtime_error', state, now }), false);
  });

  test('same job, NEW category → notify', () => {
    const state = {
      last_notified: { 'dream:runtime_error': new Date(now - 1000).toISOString() },
    };
    assert.equal(shouldNotify({ jobName: 'dream', category: 'auth_expired', state, now }), true);
  });

  test('global auth_expired debounce suppresses across all jobs', () => {
    const state = {
      last_notified: { '*:auth_expired': new Date(now - 1000).toISOString() },
    };
    assert.equal(shouldNotify({ jobName: 'dream', category: 'auth_expired', state, now }), false);
    assert.equal(shouldNotify({ jobName: 'sync-lunch-money', category: 'auth_expired', state, now }), false);
  });

  test('global auth_expired debounce expires after 6h', () => {
    const state = {
      last_notified: { '*:auth_expired': new Date(now - 7 * 60 * 60 * 1000).toISOString() },
    };
    assert.equal(shouldNotify({ jobName: 'dream', category: 'auth_expired', state, now }), true);
  });

  test('notify_on_failure: false suppresses', () => {
    assert.equal(
      shouldNotify({ jobName: 'rangers-news', category: 'runtime_error', notifyOnFailure: false, state: {}, now }),
      false
    );
  });

  test('env-suppressed suppresses everything', () => {
    assert.equal(
      shouldNotify({ jobName: 'dream', category: 'runtime_error', envSuppressed: true, state: {}, now }),
      false
    );
  });

  test('null category never notifies', () => {
    assert.equal(shouldNotify({ jobName: 'dream', category: null, state: {}, now }), false);
  });
});

describe('recordNotification / clearDedupForJob', () => {
  test('records job:category and the global bucket for auth_expired', () => {
    const out = recordNotification({
      jobName: 'dream',
      category: 'auth_expired',
      state: {},
      now: new Date('2026-04-29T04:00:14Z'),
    });
    assert.ok(out.last_notified['dream:auth_expired']);
    assert.ok(out.last_notified['*:auth_expired']);
  });

  test('non-auth category does not write the global bucket', () => {
    const out = recordNotification({
      jobName: 'dream',
      category: 'runtime_error',
      state: {},
      now: new Date('2026-04-29T04:00:14Z'),
    });
    assert.ok(out.last_notified['dream:runtime_error']);
    assert.equal(out.last_notified['*:runtime_error'], undefined);
  });

  test('clearDedupForJob removes only that job keys', () => {
    const state = {
      last_notified: {
        'dream:runtime_error': '2026-04-29T04:00:14Z',
        'dream:auth_expired': '2026-04-29T05:00:14Z',
        'backup:runtime_error': '2026-04-29T03:00:14Z',
        '*:auth_expired': '2026-04-29T05:00:14Z',
      },
    };
    const out = clearDedupForJob(state, 'dream');
    assert.equal(out.last_notified['dream:runtime_error'], undefined);
    assert.equal(out.last_notified['dream:auth_expired'], undefined);
    assert.ok(out.last_notified['backup:runtime_error']);
    assert.ok(out.last_notified['*:auth_expired']);
  });
});

describe('notificationText', () => {
  test('auth_expired body is actionable', () => {
    const { title, body } = notificationText({ jobName: 'dream', category: 'auth_expired' });
    assert.match(title, /Robin: dream failed/);
    assert.match(body, /auth expired/i);
    assert.match(body, /claude login/);
  });

  test('command_not_found body suggests sync', () => {
    const { body } = notificationText({ jobName: 'dream', category: 'command_not_found' });
    assert.match(body, /command not found/i);
    assert.match(body, /robin jobs sync/);
  });

  test('runtime_error body includes truncated error line', () => {
    const errorLine = 'x'.repeat(300);
    const { body } = notificationText({ jobName: 'dream', category: 'runtime_error', errorLine });
    assert.ok(body.length <= 200, `body length ${body.length}`);
  });
});
