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
test('no window: arm with surrounding whitespace is not an arm call', () => {
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
