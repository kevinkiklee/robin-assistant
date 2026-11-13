// Blind-window policy (spec 6.3). While a window is open on a tab that shows a
// key, the opening session may only click, run pre-approved scripts, close or
// navigate that tab, look up tool schemas, and run `robin secret set|abort`.
// Other sessions keep working but may not touch that tab, the screen or the
// clipboard. Deny reasons never echo tool input: a page script or command could
// carry anything.

import { hashText } from '../clipboard.ts';
import { isExpired, type SecretWindow } from '../window.ts';
import type { HookInput } from './io.ts';

export type GuardDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'allow'; recordArm: { tabId: number } };

const CHROME = 'mcp__claude-in-chrome__';
const ARM_RE = /^robin secret arm --tab (\d+)\s*$/;
const SET_OR_ABORT_RE = /^robin secret (set|abort)(\s|$)/;
const ABORT_RE = /^robin secret abort(\s|$)/;
// Superset of the brief's list: also refuses redirects, `$VAR`, subshells and
// process substitution, and a CR that some shells treat as a separator.
const SHELL_META_RE = /[;&|`$()<>\n\r]/;
// Shell routes to the clipboard or to the screen/Chrome tab (best effort, not a sandbox).
const SCREEN_OR_CLIPBOARD_RE = /pbpaste|clipboard|pasteboard|screencapture|osascript/i;
// claude-in-chrome tools that take no tab and return no page content.
const TAB_AGNOSTIC = new Set([
  'tabs_context_mcp',
  'tabs_create_mcp',
  'list_connected_browsers',
  'select_browser',
  'switch_browser',
]);
// Desktop tools that can see the Chrome window or read the clipboard.
const OTHER_SESSION_DENY = new Set([
  'mcp__computer-use__read_clipboard',
  'mcp__computer-use__screenshot',
  'mcp__computer-use__zoom',
  'mcp__computer-use__computer_batch',
]);

const ALLOW: GuardDecision = { decision: 'allow' };
const deny = (reason: string): GuardDecision => ({ decision: 'deny', reason });

function tabOf(input: Record<string, unknown>): number | undefined {
  const t = input.tabId;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string' && /^\d+$/.test(t)) return Number(t);
  return undefined;
}

function commandOf(input: HookInput): string | undefined {
  const c = input.tool_input.command;
  return typeof c === 'string' ? c : undefined;
}

function isRobinSecretCommand(cmd: string | undefined, re: RegExp): boolean {
  return cmd !== undefined && re.test(cmd) && !SHELL_META_RE.test(cmd);
}

function armTab(input: HookInput): number | undefined {
  if (input.tool_name !== 'Bash') return undefined;
  const m = ARM_RE.exec((commandOf(input) ?? '').trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** True when the call is a Bash `robin secret arm --tab <n>` (the only call that needs node with no window). */
export function isArmCall(input: HookInput): boolean {
  return armTab(input) !== undefined;
}

function sameSessionAllowed(input: HookInput, win: SecretWindow): boolean {
  const ti = input.tool_input;
  switch (input.tool_name) {
    case 'ToolSearch':
      return true;
    case 'Bash':
      return isRobinSecretCommand(commandOf(input), SET_OR_ABORT_RE);
    case `${CHROME}computer`:
      return ti.action === 'left_click' && tabOf(ti) === win.tabId;
    case `${CHROME}javascript_tool`:
      return (
        tabOf(ti) === win.tabId &&
        typeof ti.text === 'string' &&
        win.scriptHashes.includes(hashText(ti.text))
      );
    case `${CHROME}tabs_close_mcp`:
      return tabOf(ti) === win.tabId;
    case `${CHROME}navigate`: {
      const url = typeof ti.url === 'string' ? ti.url.trim().toLowerCase() : '';
      return tabOf(ti) === win.tabId && !url.startsWith('javascript:');
    }
    default:
      return false;
  }
}

function chromeTouchesWindowTab(tool: string, ti: Record<string, unknown>, tab: number): boolean {
  if (tool === 'browser_batch') {
    const actions = ti.actions;
    if (!Array.isArray(actions)) return true;
    return actions.some((a) => {
      if (typeof a !== 'object' || a === null) return true;
      const { name, input } = a as { name?: unknown; input?: unknown };
      if (typeof name !== 'string') return true;
      if (typeof input !== 'object' || input === null) return !TAB_AGNOSTIC.has(name);
      return chromeTouchesWindowTab(name, input as Record<string, unknown>, tab);
    });
  }
  if (TAB_AGNOSTIC.has(tool)) return false;
  const t = tabOf(ti);
  return t === undefined || t === tab;
}

function otherSessionDenied(input: HookInput, win: SecretWindow): boolean {
  const tool = input.tool_name;
  if (tool.startsWith(CHROME)) {
    return chromeTouchesWindowTab(tool.slice(CHROME.length), input.tool_input, win.tabId);
  }
  if (OTHER_SESSION_DENY.has(tool)) return true;
  // chrome-devtools-mcp addresses pages by its own index, not the tab id.
  if (tool.includes('chrome-devtools')) return true;
  const cmd = commandOf(input);
  return cmd !== undefined && SCREEN_OR_CLIPBOARD_RE.test(cmd);
}

export function decideGuard(input: HookInput, win: SecretWindow | null, now: Date): GuardDecision {
  if (!win) {
    const tabId = armTab(input);
    return tabId === undefined ? ALLOW : { decision: 'allow', recordArm: { tabId } };
  }

  if (input.session_id !== win.sessionId) {
    return otherSessionDenied(input, win)
      ? deny(
          'Another session has a blind secret window open: the browser tab, screen and clipboard are off limits until it closes (at most a few minutes).',
        )
      : ALLOW;
  }

  if (win.status === 'open' && isExpired(win, now)) {
    return input.tool_name === 'Bash' && isRobinSecretCommand(commandOf(input), ABORT_RE)
      ? ALLOW
      : deny(
          `Secret window expired with no save. Run \`robin secret abort\`, then tell the operator a ${win.provider} key may be live and unsaved.`,
        );
  }

  return sameSessionAllowed(input, win)
    ? ALLOW
    : deny(
        `A blind secret window is open on tab ${win.tabId}. Allowed now: left_click, approved scripts, tabs_close_mcp or navigate on that tab, ToolSearch, and \`robin secret set …\` / \`robin secret abort\` (no shell operators).`,
      );
}
