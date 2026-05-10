// PreToolUse Bash policy handler. Static pattern match — no daemon round
// trip, no network, no DB. Intended to be invoked by `robin hook
// PreToolUse` from Claude Code / Gemini settings.
//
// Hook contract (Claude Code, current shape):
//   stdin JSON has shape { tool_name, tool_input: { command, ... }, ... }
//
// We tolerate field-name drift across Claude Code versions by trying
// multiple accessor paths in priority order. If no command is found we
// exit 0 (fail-soft) so the host's tool call proceeds — bash policy is
// defense-in-depth, not the only line.

import { checkBashCommand } from '../bash-patterns.js';

function extractCommand(stdin) {
  if (!stdin || typeof stdin !== 'object') return undefined;
  // Current Claude Code shape.
  const a = stdin.tool_input?.command;
  if (typeof a === 'string') return a;
  // Older / alternate shape: bare `command`.
  if (typeof stdin.command === 'string') return stdin.command;
  // Yet-older shape: `input.command`.
  const c = stdin.input?.command;
  if (typeof c === 'string') return c;
  return undefined;
}

/**
 * Run the Bash policy check.
 *
 * @param {object} args
 * @param {object} [args.stdin]   Parsed hook payload (JSON object).
 * @param {(code: number) => void} [args.exit]    Defaults to process.exit.
 * @param {(s: string) => void}    [args.stderr]  Defaults to writing to
 *   process.stderr. Each call writes a single line; the handler appends
 *   the trailing newline itself.
 */
export async function bashPolicyHandler({ stdin, exit, stderr } = {}) {
  const doExit = typeof exit === 'function' ? exit : (code) => process.exit(code);
  const writeErr = typeof stderr === 'function' ? stderr : (s) => process.stderr.write(`${s}\n`);

  const cmd = extractCommand(stdin);
  if (typeof cmd !== 'string' || cmd.length === 0) {
    // Fail-soft: nothing to check.
    return;
  }

  const verdict = checkBashCommand(cmd);
  if (verdict.blocked) {
    writeErr(`Robin: blocked Bash — ${verdict.name}: ${verdict.why}`);
    doExit(2);
  }
}
