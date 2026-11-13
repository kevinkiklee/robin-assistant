// Blind-window policy (spec 6.3). While a window is open on a tab that shows a
// key, the opening session may only click, run pre-approved scripts, close or
// navigate that tab, look up tool schemas, and run `robin secret set|abort`.
// Other sessions keep working but may not touch that tab, the screen or the
// clipboard. Deny reasons never echo tool input: a page script or command could
// carry anything.

import { hashText } from '../clipboard.ts';
import { ARM_TTL_MS, isExpired, type SecretWindow } from '../window.ts';
import type { HookInput } from './io.ts';

export type GuardDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'allow'; recordArm: { tabId: number } };

// Two matches, split by direction. ALLOW decisions use the anchored form (the
// real server, optionally plugin-namespaced), so a server merely named
// `…claude-in-chrome__` gets nothing. DENY decisions use the substring, so any
// lookalike is still kept off the window tab.
const CHROME_ALLOW_RE = /^mcp__(?:plugin_[A-Za-z0-9_-]+_)?claude-in-chrome__([a-z_]+)$/;
const CHROME = 'claude-in-chrome__';
const COMPUTER_USE = 'computer-use__';
const ARM_RE = /^robin secret arm --tab (\d+)\s*$/;
const SET_OR_ABORT_RE = /^robin secret (set|abort)(\s|$)/;
const ABORT_RE = /^robin secret abort(\s|$)/;
// Superset of the brief's list: also refuses redirects, `$VAR`, subshells and
// process substitution, and a CR that some shells treat as a separator.
const SHELL_META_RE = /[;&|`$()<>\n\r]/;
// Other sessions' shell commands: a substring tripwire, best effort and NOT a
// security boundary. Quoting (pb""paste), variables or a script file evade it.
const SCREEN_OR_CLIPBOARD_RE = /pbpaste|clipboard|pasteboard|screencapture|osascript/i;
// claude-in-chrome tools that take no tab and return no page content.
const TAB_AGNOSTIC = new Set([
  'tabs_context_mcp',
  'tabs_create_mcp',
  'list_connected_browsers',
  'select_browser',
  'switch_browser',
]);

const ALLOW: GuardDecision = { decision: 'allow' };
const deny = (reason: string): GuardDecision => ({ decision: 'deny', reason });

/** The tool input's tabId as a number; a digits-only string ("7") counts as 7. */
export function tabOf(input: Record<string, unknown>): number | undefined {
  const t = input.tabId;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string' && /^\d+$/.test(t)) return Number(t);
  return undefined;
}

/** Bare tool name (`computer`) for the genuine claude-in-chrome server only; used to allow. */
export function chromeToolNameForAllow(tool: string): string | undefined {
  return CHROME_ALLOW_RE.exec(tool)?.[1];
}

/** Bare tool name for anything that looks like claude-in-chrome; used to deny. */
function chromeToolNameForDeny(tool: string): string | undefined {
  const i = tool.indexOf(CHROME);
  return i < 0 ? undefined : tool.slice(i + CHROME.length);
}

/** C0 controls (U+0000–U+001F) or DEL. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/**
 * Navigation may only leave for a real web page; closing the tab is the exit.
 * Browsers strip tabs/newlines and leading C0 controls before parsing a URL, so
 * `java\tscript:` is still javascript:. Refuse any control char, then require a
 * parsed http(s) URL (bare hosts, `back`/`forward`, data:, blob:, file:,
 * view-source: all fail).
 */
function isWebUrl(url: unknown): boolean {
  if (typeof url !== 'string' || hasControlChar(url)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
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
  const m = ARM_RE.exec(commandOf(input) ?? '');
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
  if (input.tool_name === 'ToolSearch') return true;
  if (input.tool_name === 'Bash') return isRobinSecretCommand(commandOf(input), SET_OR_ABORT_RE);
  const chrome = chromeToolNameForAllow(input.tool_name);
  if (chrome === undefined || tabOf(ti) !== win.tabId) return false;
  switch (chrome) {
    case 'computer':
      return ti.action === 'left_click';
    case 'javascript_tool':
      return typeof ti.text === 'string' && win.scriptHashes.includes(hashText(ti.text));
    case 'tabs_close_mcp':
      return true;
    case 'navigate':
      return isWebUrl(ti.url);
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
  const chrome = chromeToolNameForDeny(tool);
  if (chrome !== undefined) return chromeTouchesWindowTab(chrome, input.tool_input, win.tabId);
  // Every computer-use tool can see the desktop (Chrome included) or the clipboard.
  if (tool.includes(COMPUTER_USE)) return true;
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

export const ARM_BUSY_REASON = 'Another session is arming a secret window; wait 10 s and retry.';

/**
 * Whether an existing arm-session record blocks `sessionId` from arming: it does
 * when another session wrote it within the arm TTL. A record that is stale,
 * future-dated, unreadable or our own may be overwritten.
 */
export function armBlocked(existing: unknown, sessionId: string, now: Date): boolean {
  if (typeof existing !== 'object' || existing === null) return false;
  const { sessionId: owner, at } = existing as { sessionId?: unknown; at?: unknown };
  if (typeof owner !== 'string' || owner === sessionId || typeof at !== 'string') return false;
  const age = now.getTime() - new Date(at).getTime();
  return Number.isFinite(age) && age >= 0 && age <= ARM_TTL_MS;
}
