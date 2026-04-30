// system/scripts/lib/handoff.js
//
// Append-or-replace session-keyed blocks in markdown files. Used by:
//   - system/scripts/claude-code-hook.js (Stop-hook auto-line)
//   - the agent's in-session sweep (T1/T2 triggers)
//
// Block format:
//   ## Session — <session-id>
//   <body lines until next "## Session — " or EOF>
//
// Atomic write: stage to <file>.tmp, then renameSync.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const HEADER_RE = /^## Session — (.+)$/;

export function writeSessionBlock(filePath, sessionId, blockBody, opts = {}) {
  const { maxBlocks = Infinity, position = 'top' } = opts;
  if (!existsSync(filePath)) {
    throw new Error(`writeSessionBlock: file does not exist: ${filePath}`);
  }
  const original = readFileSync(filePath, 'utf8');
  const header = `## Session — ${sessionId}`;
  const newBlock = `${header}\n${blockBody.trim()}\n`;

  // Split into intro + array of session blocks (each starts with "## Session — ")
  const lines = original.split('\n');
  let introEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (HEADER_RE.test(lines[i])) {
      introEnd = i;
      break;
    }
  }
  const intro = lines.slice(0, introEnd).join('\n');
  const rest = lines.slice(introEnd).join('\n');

  // Parse existing session blocks from rest
  const blocks = [];
  let current = null;
  for (const line of rest.split('\n')) {
    const m = line.match(HEADER_RE);
    if (m) {
      if (current) blocks.push(current);
      current = { id: m[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);

  let action;
  const existingIdx = blocks.findIndex((b) => b.id === sessionId);
  if (existingIdx >= 0) {
    blocks[existingIdx] = { id: sessionId, lines: newBlock.trimEnd().split('\n') };
    action = 'replaced';
  } else {
    if (position === 'top') blocks.unshift({ id: sessionId, lines: newBlock.trimEnd().split('\n') });
    else blocks.push({ id: sessionId, lines: newBlock.trimEnd().split('\n') });
    action = 'created';
  }

  // Trim to maxBlocks (keep the freshest = at top in 'top' mode)
  const trimmed = position === 'top' ? blocks.slice(0, maxBlocks) : blocks.slice(-maxBlocks);

  const rebuilt = (intro.endsWith('\n') ? intro : intro + '\n')
    + trimmed.map((b) => b.lines.join('\n').trimEnd()).join('\n\n')
    + '\n';

  if (rebuilt === original) return { changed: false, action: 'noop' };

  // Atomic write
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, rebuilt);
  renameSync(tmp, filePath);
  return { changed: true, action };
}
