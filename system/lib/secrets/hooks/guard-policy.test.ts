import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SecretWindow } from '../window.ts';
import { armBlocked, decideGuard, type GuardDecision } from './guard-policy.ts';
import type { HookInput } from './io.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const now = new Date('2026-01-01T00:01:00.000Z');
const win: SecretWindow = {
  sessionId: 's1',
  tabId: 7,
  provider: 'acme',
  name: 'ACME_KEY',
  scriptHashes: [sha('LOCATE')],
  clipboardHashAtArm: 'c1',
  openedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  status: 'open',
};
const expired: SecretWindow = { ...win, expiresAt: new Date(now.getTime() - 1).toISOString() };

const call = (
  session: string,
  tool: string,
  toolInput: Record<string, unknown> = {},
): HookInput => ({ session_id: session, tool_name: tool, tool_input: toolInput });
const chrome = (t: string) => `mcp__claude-in-chrome__${t}`;
const bash = (session: string, command: string) => call(session, 'Bash', { command });

const ALLOW: GuardDecision = { decision: 'allow' };
function denied(d: GuardDecision): string {
  assert.equal(d.decision, 'deny');
  return (d as { reason: string }).reason;
}

// Same session, window open.
test('same session: screenshot denied', () => {
  denied(decideGuard(call('s1', chrome('computer'), { action: 'screenshot', tabId: 7 }), win, now));
});
test('same session: read_page denied', () => {
  denied(decideGuard(call('s1', chrome('read_page'), { tabId: 7 }), win, now));
});
test('same session: find denied', () => {
  denied(decideGuard(call('s1', chrome('find'), { tabId: 7, query: 'key' }), win, now));
});
test('same session: get_page_text denied', () => {
  denied(decideGuard(call('s1', chrome('get_page_text'), { tabId: 7 }), win, now));
});
test('same session: left_click on the window tab allowed', () => {
  const d = decideGuard(
    call('s1', chrome('computer'), { action: 'left_click', coordinate: [1, 2], tabId: 7 }),
    win,
    now,
  );
  assert.deepEqual(d, ALLOW);
});
test('same session: left_click on another tab denied', () => {
  denied(decideGuard(call('s1', chrome('computer'), { action: 'left_click', tabId: 8 }), win, now));
});
test('same session: approved script allowed', () => {
  const d = decideGuard(
    call('s1', chrome('javascript_tool'), { action: 'javascript_exec', text: 'LOCATE', tabId: 7 }),
    win,
    now,
  );
  assert.deepEqual(d, ALLOW);
});
test('same session: unapproved script denied', () => {
  const reason = denied(
    decideGuard(
      call('s1', chrome('javascript_tool'), { text: 'document.body.innerText', tabId: 7 }),
      win,
      now,
    ),
  );
  assert.ok(!reason.includes('innerText'), 'reason must not echo tool input');
});
test('same session: tabs_close on the window tab allowed', () => {
  assert.deepEqual(
    decideGuard(call('s1', chrome('tabs_close_mcp'), { tabId: 7 }), win, now),
    ALLOW,
  );
});
test('same session: robin secret set from clipboard allowed', () => {
  assert.deepEqual(decideGuard(bash('s1', 'robin secret set X --from-clipboard'), win, now), ALLOW);
});
test('same session: robin secret set chained with pbpaste denied', () => {
  const reason = denied(decideGuard(bash('s1', 'robin secret set X; pbpaste'), win, now));
  assert.ok(!reason.includes('pbpaste'), 'reason must not echo tool input');
});
test('same session: cat .env denied', () => {
  denied(decideGuard(bash('s1', 'cat .env'), win, now));
});
test('same session: Read tool denied', () => {
  denied(decideGuard(call('s1', 'Read', { file_path: '/x' }), win, now));
});

// Other session, window open.
test('other session: claude-in-chrome on the window tab denied', () => {
  denied(decideGuard(call('s2', chrome('get_page_text'), { tabId: 7 }), win, now));
});
test('other session: claude-in-chrome on another tab allowed', () => {
  assert.deepEqual(decideGuard(call('s2', chrome('get_page_text'), { tabId: 9 }), win, now), ALLOW);
});
test('other session: read_clipboard denied', () => {
  denied(decideGuard(call('s2', 'mcp__computer-use__read_clipboard'), win, now));
});
test('other session: Bash pbpaste denied', () => {
  denied(decideGuard(bash('s2', 'pbpaste'), win, now));
});
test('other session: Bash ls allowed', () => {
  assert.deepEqual(decideGuard(bash('s2', 'ls'), win, now), ALLOW);
});

// Expired, status open.
test('expired: same-session left_click denied with the abort instruction', () => {
  const reason = denied(
    decideGuard(call('s1', chrome('computer'), { action: 'left_click', tabId: 7 }), expired, now),
  );
  assert.equal(
    reason,
    'Secret window expired with no save. Run `robin secret abort`, then tell the operator a acme key may be live and unsaved.',
  );
});
test('expired: robin secret abort allowed', () => {
  assert.deepEqual(decideGuard(bash('s1', 'robin secret abort'), expired, now), ALLOW);
});

// No window.
test('no window: robin secret arm records the arming session', () => {
  assert.deepEqual(decideGuard(bash('s1', 'robin secret arm --tab 7'), null, now), {
    decision: 'allow',
    recordArm: { tabId: 7 },
  });
});
test('no window: anything else allowed', () => {
  assert.deepEqual(decideGuard(call('s1', 'Read', { file_path: '/x' }), null, now), ALLOW);
});

// Hardening beyond the brief's table.
test('same session: ToolSearch allowed (schemas only)', () => {
  assert.deepEqual(decideGuard(call('s1', 'ToolSearch', { query: 'select:x' }), win, now), ALLOW);
});
test('same session: navigate to a javascript: URL denied', () => {
  denied(
    decideGuard(call('s1', chrome('navigate'), { tabId: 7, url: 'JavaScript:alert(1)' }), win, now),
  );
});
test('same session: robin secret set with a redirect or subshell denied', () => {
  denied(decideGuard(bash('s1', 'robin secret set X > /tmp/out'), win, now));
  denied(decideGuard(bash('s1', 'robin secret set X\npbpaste'), win, now));
  denied(decideGuard(bash('s1', ' robin secret set X'), win, now));
});
test('saved window: same-session allowlist still applies after expiry, no expiry message', () => {
  const saved: SecretWindow = { ...expired, status: 'saved' };
  assert.deepEqual(
    decideGuard(call('s1', chrome('tabs_close_mcp'), { tabId: 7 }), saved, now),
    ALLOW,
  );
  const reason = denied(decideGuard(call('s1', chrome('read_page'), { tabId: 7 }), saved, now));
  assert.ok(!reason.includes('expired'));
});
test('other session: tab id as a string or missing still denied', () => {
  denied(decideGuard(call('s2', chrome('read_page'), { tabId: '7' }), win, now));
  denied(decideGuard(call('s2', chrome('read_page'), {}), win, now));
  assert.deepEqual(decideGuard(call('s2', chrome('tabs_context_mcp'), {}), win, now), ALLOW);
});
test('other session: browser_batch touching the window tab denied', () => {
  const batch = (tabId: unknown) =>
    call('s2', chrome('browser_batch'), {
      actions: [{ name: 'get_page_text', input: { tabId } }],
    });
  denied(decideGuard(batch(7), win, now));
  denied(decideGuard(batch(undefined), win, now));
  assert.deepEqual(decideGuard(batch(9), win, now), ALLOW);
});
test('other session: desktop screenshots and clipboard commands denied', () => {
  denied(decideGuard(call('s2', 'mcp__computer-use__screenshot'), win, now));
  denied(decideGuard(call('s2', 'Monitor', { command: 'osascript -e "the clipboard"' }), win, now));
  denied(decideGuard(bash('s2', 'screencapture -x /tmp/a.png'), win, now));
});
test('window present: robin secret arm is not recorded', () => {
  denied(decideGuard(bash('s1', 'robin secret arm --tab 7'), win, now));
  assert.deepEqual(decideGuard(bash('s2', 'robin secret arm --tab 7'), win, now), ALLOW);
});

// Fix round 1.
const nav = (session: string, tabId: number, url: string) =>
  call(session, chrome('navigate'), { tabId, url });
test('same session: navigate with control-char javascript: bypasses denied', () => {
  for (const url of [
    'java\tscript:alert(1)',
    'jav\nascript:alert(1)',
    '\u0001javascript:alert(1)',
  ]) {
    denied(decideGuard(nav('s1', 7, url), win, now));
  }
});
test('same session: navigate to non-web schemes denied', () => {
  for (const url of [
    'data:text/html,x',
    'blob:https://x/1',
    'view-source:https://x',
    'file:///etc/hosts',
  ]) {
    denied(decideGuard(nav('s1', 7, url), win, now));
  }
});
test('same session: navigate back/forward and bare hosts denied', () => {
  for (const url of ['back', 'forward', 'dash.example.com']) {
    denied(decideGuard(nav('s1', 7, url), win, now));
  }
});
test('same session: navigate to an https page on the window tab allowed', () => {
  assert.deepEqual(decideGuard(nav('s1', 7, 'https://dash.example.com/tokens'), win, now), ALLOW);
});
test('same session: navigate and tabs_close on another tab denied', () => {
  denied(decideGuard(nav('s1', 8, 'https://dash.example.com/tokens'), win, now));
  denied(decideGuard(call('s1', chrome('tabs_close_mcp'), { tabId: 8 }), win, now));
});
test('plugin-namespaced claude-in-chrome tools are matched', () => {
  const ns = (t: string) => `mcp__plugin_cic_claude-in-chrome__${t}`;
  denied(decideGuard(call('s2', ns('get_page_text'), { tabId: 7 }), win, now));
  denied(decideGuard(call('s1', ns('read_page'), { tabId: 7 }), win, now));
  assert.deepEqual(
    decideGuard(call('s1', ns('computer'), { action: 'left_click', tabId: 7 }), win, now),
    ALLOW,
  );
});
test('other session: every computer-use tool denied', () => {
  denied(decideGuard(call('s2', 'mcp__computer-use__left_click'), win, now));
  denied(decideGuard(call('s2', 'mcp__computer-use__open_application'), win, now));
});
test('expired: robin secret abort chained with another command denied', () => {
  denied(decideGuard(bash('s1', 'robin secret abort; x'), expired, now));
});
test('no window: arm with a leading space is not an arm call; trailing whitespace is', () => {
  assert.deepEqual(decideGuard(bash('s1', ' robin secret arm --tab 7'), null, now), ALLOW);
  assert.deepEqual(decideGuard(bash('s1', 'robin secret arm --tab 7  '), null, now), {
    decision: 'allow',
    recordArm: { tabId: 7 },
  });
});
test('armBlocked: fresh record from another session blocks; own, stale or junk does not', () => {
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(armBlocked({ sessionId: 's2', tabId: 7, at: at(5_000) }, 's1', now), true);
  assert.equal(armBlocked({ sessionId: 's2', tabId: 7, at: at(10_000) }, 's1', now), true);
  assert.equal(armBlocked({ sessionId: 's2', tabId: 7, at: at(10_001) }, 's1', now), false);
  assert.equal(armBlocked({ sessionId: 's1', tabId: 7, at: at(1_000) }, 's1', now), false);
  assert.equal(armBlocked({ sessionId: 's2', tabId: 7, at: at(-60_000) }, 's1', now), false);
  assert.equal(armBlocked(undefined, 's1', now), false);
  assert.equal(armBlocked({ sessionId: 's2', at: 'nope' }, 's1', now), false);
});

// Fix round 2.
test('same session: lookalike chrome server is not allowed to click', () => {
  denied(
    decideGuard(
      call('s1', 'mcp__evil-claude-in-chrome__computer', { action: 'left_click', tabId: 7 }),
      win,
      now,
    ),
  );
});
test('same session: plugin-namespaced chrome server allowed to click', () => {
  assert.deepEqual(
    decideGuard(
      call('s1', 'mcp__plugin_chrome_claude-in-chrome__computer', {
        action: 'left_click',
        tabId: 7,
      }),
      win,
      now,
    ),
    ALLOW,
  );
});
test('other session: lookalike chrome server on the window tab denied', () => {
  denied(decideGuard(call('s2', 'mcp__evil-claude-in-chrome__read_page', { tabId: 7 }), win, now));
});

// F4: other sessions and a window past its expiry.
const at = (ms: number) => new Date(ms);
const hhmmss = (ms: number) => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};
test('other session: robin secret abort denied while the window is live, naming its expiry', () => {
  const reason = denied(decideGuard(bash('s2', 'robin secret abort'), win, now));
  assert.equal(
    reason,
    `A secret window is open in another session; it expires at ${hhmmss(Date.parse(win.expiresAt) + 10 * 60_000)}.`,
  );
  denied(decideGuard(bash('s2', 'cd /x && robin secret abort'), win, now));
});
test('other session: every status (open included) releases only 10 min past expiry', () => {
  const exp = Date.parse(expired.expiresAt);
  for (const status of ['open', 'saved', 'aborted'] as const) {
    const w: SecretWindow = { ...expired, status };
    for (const t of [exp + 60_000, exp + 10 * 60_000 - 1]) {
      const reason = denied(decideGuard(bash('s2', 'robin secret abort'), w, at(t)));
      assert.match(reason, new RegExp(`expires at ${hhmmss(exp + 10 * 60_000)}`));
      denied(decideGuard(call('s2', chrome('read_page'), { tabId: 7 }), w, at(t)));
      denied(decideGuard(bash('s2', 'pbpaste'), w, at(t)));
    }
    for (const t of [exp + 10 * 60_000, exp + 11 * 60_000]) {
      assert.deepEqual(decideGuard(bash('s2', 'robin secret abort'), w, at(t)), ALLOW, status);
      assert.deepEqual(
        decideGuard(call('s2', chrome('read_page'), { tabId: 7 }), w, at(t)),
        ALLOW,
        'denials stop',
      );
    }
  }
});
test('other session: a NaN expiry never releases', () => {
  for (const status of ['open', 'saved', 'aborted'] as const) {
    const w: SecretWindow = { ...win, expiresAt: 'not a date', status };
    const later = at(now.getTime() + 365 * 24 * 3_600_000);
    const reason = denied(decideGuard(bash('s2', 'robin secret abort'), w, later));
    assert.match(reason, /expires at an unknown time/);
    denied(decideGuard(call('s2', chrome('read_page'), { tabId: 7 }), w, later));
  }
});
test('other session: live denial names the release time and how to clear it', () => {
  const reason = denied(decideGuard(bash('s2', 'pbpaste'), win, now));
  assert.match(reason, /robin secret abort/);
  assert.match(reason, new RegExp(hhmmss(Date.parse(win.expiresAt) + 10 * 60_000)));
  assert.doesNotMatch(reason, /few minutes/);
});
test('same session: a saved window says to run robin secret abort if the tab is gone', () => {
  const saved: SecretWindow = { ...win, status: 'saved' };
  const reason = denied(decideGuard(call('s1', chrome('read_page'), { tabId: 7 }), saved, now));
  assert.match(reason, /If the tab is already gone, run `robin secret abort`/);
  const open = denied(decideGuard(call('s1', chrome('read_page'), { tabId: 7 }), win, now));
  assert.doesNotMatch(open, /already gone/);
});

// F7: the redaction marker never goes back into a file.
const MARKER = '[REDACTED-SECRET]';
test('marker edits are denied in every session, window or not', () => {
  const edits: HookInput[] = [
    call('s9', 'Edit', { file_path: '/p/.env', old_string: 'A=1', new_string: `A=${MARKER}` }),
    call('s9', 'Write', { file_path: '/p/.env', content: `A=${MARKER}\n` }),
    call('s9', 'MultiEdit', {
      file_path: '/p/.env',
      edits: [
        { old_string: 'x', new_string: 'y' },
        { old_string: 'B=1', new_string: MARKER },
      ],
    }),
    call('s9', 'NotebookEdit', {
      notebook_path: '/p/secrets.ipynb',
      new_source: `k = "${MARKER}"`,
    }),
  ];
  for (const e of edits) {
    for (const w of [null, win, { ...win, sessionId: 's9' }]) {
      assert.equal(
        denied(decideGuard(e, w, now)),
        'This edit would write the redaction marker [REDACTED-SECRET] into a file; the original value was hidden from you. Leave that line unchanged.',
      );
    }
  }
});
test('marker: other tools and marker-free edits are unaffected', () => {
  assert.deepEqual(decideGuard(bash('s1', `grep -n '${MARKER}' f`), null, now), ALLOW);
  assert.deepEqual(
    decideGuard(
      call('s1', 'Edit', { file_path: '/p', old_string: 'a', new_string: 'b' }),
      null,
      now,
    ),
    ALLOW,
  );
});

// I1: the marker deny covers secret/config-like targets only; code and docs that
// mention the marker literal stay editable.
const isMarkerDeny = (d: GuardDecision) =>
  d.decision === 'deny' && d.reason.includes('Leave that line unchanged');
test('marker: code and doc files that contain the marker literal may be edited', () => {
  const allowed: HookInput[] = [
    call('s1', 'Edit', {
      file_path: 'system/lib/secrets/hooks/redact-policy.ts',
      old_string: 'a',
      new_string: `const REDACTED = '${MARKER}';`,
    }),
    call('s1', 'Write', { file_path: '/p/notes.md', content: `the marker is ${MARKER}\n` }),
    call('s1', 'Write', { file_path: '/p/tool.py', content: `M = "${MARKER}"\n` }),
  ];
  for (const e of allowed) assert.deepEqual(decideGuard(e, null, now), ALLOW);
});
test('marker: secret- and config-like targets are denied', () => {
  const denies: HookInput[] = [
    call('s1', 'Write', { file_path: '/proj/.env.local', content: `KEY=${MARKER}\n` }),
    call('s1', 'Write', { file_path: 'config/settings.json', content: `{"k":"${MARKER}"}` }),
    call('s1', 'Edit', {
      file_path: '~/.zshrc',
      old_string: 'export A=1',
      new_string: `export A=${MARKER}`,
    }),
    call('s1', 'Write', { file_path: '/p/.npmrc', content: `//r/:_authToken=${MARKER}` }),
    call('s1', 'Write', { file_path: '/p/App.PLIST', content: MARKER }),
    call('s1', 'Write', { file_path: '/p/my-Credentials', content: MARKER }),
    call('s1', 'Write', { file_path: '/p/api_token.txt', content: MARKER }),
    call('s1', 'Write', { file_path: '/home/u/.netrc', content: MARKER }),
    call('s1', 'Write', { file_path: '/p/server.key', content: MARKER }),
  ];
  for (const e of denies) assert.ok(isMarkerDeny(decideGuard(e, null, now)), JSON.stringify(e));
});
test('marker: an edit with no or an unknown target path fails closed', () => {
  assert.ok(isMarkerDeny(decideGuard(call('s1', 'Write', { content: MARKER }), null, now)));
  assert.ok(
    isMarkerDeny(decideGuard(call('s1', 'Write', { file_path: 7, content: MARKER }), null, now)),
  );
  assert.ok(
    isMarkerDeny(decideGuard(call('s1', 'Write', { file_path: '', content: MARKER }), null, now)),
  );
});
