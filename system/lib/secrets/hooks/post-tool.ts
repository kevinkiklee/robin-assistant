// PostToolUse hook entry point (spec 6.4). Runs as its own process after every
// tool call. It (a) closes the blind window once the opening session closes or
// navigates away from the key tab after the key was saved or aborted, and
// (b) replaces any saved secret value in the tool's output with a marker before
// the model sees it. Any failure withholds the whole output. A FAILED tool
// call goes to PostToolUseFailure instead, which can't replace output, so its
// output is never redacted (see install.ts).
//
// Local modules load through dynamic import inside the try block: a static
// import that failed to load would crash the process before it could withhold,
// and Claude Code would pass the original output through. For the same reason
// this file reads stdin and writes its JSON itself instead of using io.ts.

import type { HookInput } from './io.ts';

const UNINSTALL_HINT = 'run `robin secret uninstall` to disable redaction';
const WITHHELD = `[output withheld: secret redaction hook error — ${UNINSTALL_HINT}]`;

/** The withheld notice; names the store file when that is what failed. */
function noticeFor(err: unknown): string {
  const file = (err as { name?: unknown; file?: unknown } | null)?.file;
  if (
    (err as { name?: unknown } | null)?.name === 'RedactionSourceError' &&
    typeof file === 'string'
  ) {
    return `[output withheld: the secret redaction hook could not read ${file} — fix it, or ${UNINSTALL_HINT}]`;
  }
  return WITHHELD;
}

function emitOutput(mcp: boolean, value: unknown): void {
  const key = mcp ? 'updatedMCPToolOutput' : 'updatedToolOutput';
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', [key]: value } })}\n`,
  );
}

// Strings shorter than the 16-char floor for non-vault values, and
// identifier-like strings (enum values such as `files_with_matches`), are
// kept so the replacement still matches the tool's output schema.
const KEEP_BELOW = 16;
const IDENTIFIER = /^[a-z][a-zA-Z0-9_-]*$/;
const IDENTIFIER_MAX = 64;

function keepString(s: string): boolean {
  return s.length < KEEP_BELOW || (s.length <= IDENTIFIER_MAX && IDENTIFIER.test(s));
}

function fixedWithheld(mcp: boolean, notice: string): unknown {
  return mcp
    ? [{ type: 'text', text: notice }]
    : { stdout: notice, stderr: '', interrupted: false, isImage: false };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function isImageBlock(v: object): boolean {
  return (
    !Array.isArray(v) &&
    (v as { type?: unknown }).type === 'image' &&
    (Object.hasOwn(v, 'data') || Object.hasOwn(v, 'source'))
  );
}

function containsImageBlock(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  if (isImageBlock(v)) return true;
  return (Array.isArray(v) ? v : Object.values(v)).some(containsImageBlock);
}

/**
 * The tool's own output with every string replaced by the notice, except
 * those `keepString` keeps. Object keys are never renamed and non-string
 * leaves are kept, so the result still parses as that tool's output.
 */
function blankStrings(v: unknown, notice: string): unknown {
  if (typeof v === 'string') return keepString(v) ? v : notice;
  if (typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) return v.map((item) => blankStrings(item, notice));
  const out: Obj = {};
  for (const [k, val] of Object.entries(v)) {
    // defineProperty keeps `__proto__` an own key instead of a prototype change.
    Object.defineProperty(out, k, {
      value: blankStrings(val, notice),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * The withheld replacement in the tool's own shape. Output carrying image data
 * becomes that tool's text form: an MCP text block, a Read text result, or a
 * Bash text result (other Bash keys kept, their strings blanked).
 */
function withheldFrom(
  original: unknown,
  toolInput: unknown,
  mcp: boolean,
  notice: string,
): unknown {
  if (mcp) {
    return containsImageBlock(original)
      ? fixedWithheld(true, notice)
      : blankStrings(original, notice);
  }
  if (isObj(original) && original.type === 'image' && isObj(original.file)) {
    const fromResponse = original.file.filePath;
    const fromInput = isObj(toolInput) ? toolInput.file_path : undefined;
    const filePath =
      typeof fromResponse === 'string'
        ? fromResponse
        : typeof fromInput === 'string'
          ? fromInput
          : '';
    return {
      type: 'text',
      file: { filePath, content: notice, numLines: 1, startLine: 1, totalLines: 1 },
    };
  }
  if (isObj(original) && original.isImage === true) {
    return {
      ...(blankStrings(original, notice) as Obj),
      stdout: notice,
      stderr: '',
      interrupted: false,
      isImage: false,
    };
  }
  if (typeof original === 'string' || (typeof original === 'object' && original !== null)) {
    return blankStrings(original, notice);
  }
  return fixedWithheld(false, notice);
}

/** Withholds the whole output, in the tool's own shape when the payload parses. */
function emitWithheld(mcp: boolean, raw: string | undefined, notice: string): void {
  let replacement: unknown;
  try {
    if (raw === undefined) throw new Error('no payload');
    const parsed = JSON.parse(raw) as { tool_response?: unknown; tool_input?: unknown };
    replacement = withheldFrom(parsed.tool_response, parsed.tool_input, mcp, notice);
  } catch {
    replacement = fixedWithheld(mcp, notice);
  }
  emitOutput(mcp, replacement);
}

async function readRawStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Removes a saved/aborted window when its own session closes its tab (Ruling 8:
 * closing only — a navigate could lead straight back to the key page). Errors
 * are swallowed: window trouble must never stop redaction, and a corrupt window
 * file is left for the guard (which fails closed on it).
 */
async function maybeCloseWindow(userData: string, input: HookInput): Promise<void> {
  try {
    const { chromeToolNameForAllow, tabOf } = await import('./guard-policy.ts');
    if (chromeToolNameForAllow(input.tool_name) !== 'tabs_close_mcp') return;
    const { closeWindow, readWindow } = await import('../window.ts');
    const win = readWindow(userData);
    if (!win || win.status === 'open' || win.sessionId !== input.session_id) return;
    if (tabOf(input.tool_input) !== win.tabId) return;
    closeWindow(userData);
  } catch {
    // See above.
  }
}

export async function main(): Promise<void> {
  let mcp = false;
  let raw: string | undefined;
  try {
    raw = await readRawStdin();
    // Best guess for the withheld form if the payload doesn't parse.
    mcp = /"tool_name"\s*:\s*"mcp__/.test(raw);
    const { parseHookInput } = await import('./io.ts');
    const input = parseHookInput(raw);
    mcp = input.tool_name.startsWith('mcp__');

    const { resolveUserDataDir } = await import('../../paths.ts');
    const userData = resolveUserDataDir();
    await maybeCloseWindow(userData, input);

    const { loadRedactionValues, redactOutput } = await import('./redact-policy.ts');
    const values = loadRedactionValues(userData);
    if (input.tool_response === undefined) return;
    const r = redactOutput(input.tool_response, values);
    if (r.changed) emitOutput(mcp, r.output);
  } catch (err) {
    emitWithheld(mcp, raw, noticeFor(err));
  }
}

// Unconditional: this file only ever runs as the hook.
await main();
