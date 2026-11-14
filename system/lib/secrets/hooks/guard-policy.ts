// Blind-window policy (spec 6.3). While a window is open on a tab that shows a
// key, the opening session may only click, run pre-approved scripts, close or
// navigate that tab, look up tool schemas, and run `robin secret set|abort`.
// Other sessions keep working but may not touch that tab, the screen or the
// clipboard. In every session, with or without a window, an edit may not write
// the redaction marker into anything but a code or doc file. Deny reasons never echo tool input: a
// page script or command could carry anything.

import { hashText } from '../clipboard.ts';
import { ARM_TTL_MS, isExpired, type SecretWindow } from '../window.ts';
import type { HookInput } from './io.ts';
import { REDACTED } from './redact-policy.ts';

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
// Another session's abort, in any form (a tripwire like SCREEN_OR_CLIPBOARD_RE).
const ANY_ABORT_RE = /robin\s+secret\s+abort/;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** A window keeps restricting other sessions this long past its expiry. */
export const RELEASE_GRACE_MS = 10 * 60_000;
export const MARKER_EDIT_REASON = `This edit would write the redaction marker ${REDACTED} into a file; the original value was hidden from you. Leave that line unchanged.`;
// Superset of the brief's list: also refuses redirects, `$VAR`, subshells and
// process substitution, and a CR that some shells treat as a separator.
const SHELL_META_RE = /[;&|`$()<>\n\r]/;
const BARE_ABORT_RE = /^robin secret abort\s*$/;
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

/**
 * True for a Bash `robin secret abort` with no arguments and no shell
 * operators: the one call the guard lets through when it can't read the window
 * (abort is what clears an unreadable window).
 */
export function isBareAbortCall(input: HookInput): boolean {
  return input.tool_name === 'Bash' && isRobinSecretCommand(commandOf(input), BARE_ABORT_RE);
}

/** True when the call is a Bash `robin secret arm --tab <n>` (the only call that needs node with no window). */
export function isArmCall(input: HookInput): boolean {
  return armTab(input) !== undefined;
}

function containsMarker(v: unknown): boolean {
  if (typeof v === 'string') return v.includes(REDACTED);
  if (typeof v !== 'object' || v === null) return false;
  return (Array.isArray(v) ? v : Object.values(v)).some(containsMarker);
}

// Deny by default: a redacted value read back from a config or dotfile and
// written over the real one is the failure this guards against, and config
// formats are too many to list. Only code and doc files, which merely mention
// the marker literal (this module, its tests, design notes), may carry it.
const CODE_DOC_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'rb',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'cs',
  'php',
  'md',
  'mdx',
  'txt',
  'html',
  'css',
  'scss',
]);
const SECRET_NAME_RE = /secret|credential|token/i;

/**
 * True when an edit target may carry the marker: a code or doc file (by
 * extension, with a non-empty stem) whose name doesn't start with `.env` or
 * mention a secret, credential or token. Extensionless files, dotfiles, shell
 * scripts, config formats and a missing or non-string path are all refused.
 */
function isCodeOrDocTarget(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const lower = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0 || !CODE_DOC_EXTS.has(lower.slice(dot + 1))) return false;
  return !lower.startsWith('.env') && !SECRET_NAME_RE.test(lower);
}

/**
 * True for a Write / Edit / MultiEdit / NotebookEdit whose input carries the
 * redaction marker, unless its target (file_path / notebook_path) is a code or
 * doc file.
 */
export function isMarkerEdit(input: HookInput): boolean {
  if (!EDIT_TOOLS.has(input.tool_name) || !containsMarker(input.tool_input)) return false;
  const ti = input.tool_input;
  return !isCodeOrDocTarget(input.tool_name === 'NotebookEdit' ? ti.notebook_path : ti.file_path);
}

/**
 * When the window stops restricting other sessions (epoch ms): 10 min past its
 * expiry whatever its status — an expired open window may still show the key
 * (its agent died mid-flow), and a saved/aborted one until its tab closes. An
 * unparseable expiry never releases.
 */
export function windowReleaseAt(win: SecretWindow): number {
  const exp = new Date(win.expiresAt).getTime();
  return Number.isNaN(exp) ? Number.POSITIVE_INFINITY : exp + RELEASE_GRACE_MS;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local HH:MM:SS. */
function clock(ms: number): string {
  if (!Number.isFinite(ms)) return 'an unknown time';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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
  if (isMarkerEdit(input)) return deny(MARKER_EDIT_REASON);
  if (!win) {
    const tabId = armTab(input);
    return tabId === undefined ? ALLOW : { decision: 'allow', recordArm: { tabId } };
  }

  if (input.session_id !== win.sessionId) {
    const releaseAt = windowReleaseAt(win);
    const released = now.getTime() >= releaseAt;
    const cmd = input.tool_name === 'Bash' ? commandOf(input) : undefined;
    if (cmd !== undefined && ANY_ABORT_RE.test(cmd)) {
      return released
        ? ALLOW
        : deny(`A secret window is open in another session; it expires at ${clock(releaseAt)}.`);
    }
    if (released) return ALLOW;
    return otherSessionDenied(input, win)
      ? deny(
          `Another session has a blind secret window open: the browser tab, screen and clipboard are off limits until it closes, or until ${clock(releaseAt)}; after that, \`robin secret abort\` clears it.`,
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

  if (sameSessionAllowed(input, win)) return ALLOW;
  const allowed =
    'Allowed now: left_click, approved scripts, tabs_close_mcp or navigate on that tab, ToolSearch, and `robin secret set …` / `robin secret abort` (no shell operators).';
  return deny(
    win.status === 'open'
      ? `A blind secret window is open on tab ${win.tabId}. ${allowed}`
      : `The secret window on tab ${win.tabId} is ${win.status}; close that tab with tabs_close_mcp to end it. If the tab is already gone, run \`robin secret abort\`. ${allowed}`,
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
