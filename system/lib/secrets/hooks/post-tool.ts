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

function emitWithheld(mcp: boolean): void {
  emitOutput(
    mcp,
    mcp
      ? [{ type: 'text', text: WITHHELD }]
      : { stdout: WITHHELD, stderr: '', interrupted: false, isImage: false },
  );
}

async function readRawStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Removes a saved/aborted window when its own session closes or navigates its
 * tab. Errors are swallowed: window trouble must never stop redaction, and a
 * corrupt window file is left for the guard (which fails closed on it).
 */
async function maybeCloseWindow(userData: string, input: HookInput): Promise<void> {
  try {
    const { chromeToolNameForAllow, tabOf } = await import('./guard-policy.ts');
    const tool = chromeToolNameForAllow(input.tool_name);
    if (tool !== 'tabs_close_mcp' && tool !== 'navigate') return;
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
  try {
    const raw = await readRawStdin();
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
    emitWithheld(mcp);
  }
}

// Unconditional: this file only ever runs as the hook.
await main();
