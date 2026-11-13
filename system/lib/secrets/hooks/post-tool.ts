// PostToolUse hook entry point (spec 6.4). Runs as its own process after every
// tool call. It (a) closes the blind window once the opening session closes or
// navigates away from the key tab after the key was saved or aborted, and
// (b) replaces any saved secret value in the tool's output with a marker before
// the model sees it. Any failure withholds the whole output.
//
// Local modules load through dynamic import inside the try block: a static
// import that failed to load would crash the process before it could withhold,
// and Claude Code would pass the original output through. For the same reason
// this file reads stdin and writes its JSON itself instead of using io.ts.

import type { HookInput } from './io.ts';

const WITHHELD = '[output withheld: secret redaction hook error]';

function emitOutput(mcp: boolean, value: unknown): void {
  const key = mcp ? 'updatedMCPToolOutput' : 'updatedToolOutput';
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', [key]: value } })}\n`,
  );
}

// Strings and keys shorter than the 16-char redaction floor cannot hold a whole
// saved value, so a short `type` discriminator and short keys survive withholding.
const KEEP_BELOW = 16;

function fixedWithheld(mcp: boolean): unknown {
  return mcp
    ? [{ type: 'text', text: WITHHELD }]
    : { stdout: WITHHELD, stderr: '', interrupted: false, isImage: false };
}

function isImageBlock(v: object): boolean {
  return (
    !Array.isArray(v) &&
    (v as { type?: unknown }).type === 'image' &&
    (Object.hasOwn(v, 'data') || Object.hasOwn(v, 'source'))
  );
}

/**
 * The tool's own output with every string replaced by the notice, so the
 * replacement keeps the shape Claude Code expects for that tool. Kept as is:
 * array/object structure, non-string leaves, keys under 16 chars, and short
 * `type` values. Longer keys become the notice (suffixed on collision). In an
 * MCP content list an image block becomes a text block carrying the notice.
 */
function withheldFrom(original: unknown, mcp: boolean): unknown {
  const walk = (v: unknown, key: string | undefined, inMcpList: boolean): unknown => {
    if (typeof v === 'string') {
      return v === '' || (key === 'type' && v.length < KEEP_BELOW) ? v : WITHHELD;
    }
    if (typeof v !== 'object' || v === null) return v;
    if (inMcpList && isImageBlock(v)) return { type: 'text', text: WITHHELD };
    if (Array.isArray(v)) return v.map((item) => walk(item, undefined, mcp && v === original));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const base = k.length < KEEP_BELOW ? k : WITHHELD;
      let name = base;
      for (let n = 2; Object.hasOwn(out, name); n++) name = `${base}_${n}`;
      Object.defineProperty(out, name, {
        value: walk(val, k, false),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  if (typeof original === 'string' || (typeof original === 'object' && original !== null)) {
    return walk(original, undefined, false);
  }
  return fixedWithheld(mcp);
}

/** Withholds the whole output, in the tool's own shape when the payload parses. */
function emitWithheld(mcp: boolean, raw: string | undefined): void {
  let replacement: unknown;
  try {
    if (raw === undefined) throw new Error('no payload');
    const parsed = JSON.parse(raw) as { tool_response?: unknown };
    replacement = withheldFrom(parsed.tool_response, mcp);
  } catch {
    replacement = fixedWithheld(mcp);
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
  } catch {
    emitWithheld(mcp, raw);
  }
}

// Unconditional: this file only ever runs as the hook.
await main();
