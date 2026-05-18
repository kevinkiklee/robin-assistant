// Discord reply formatter.
//
// Discord caps each message at DISCORD_MESSAGE_MAX (2000) chars and renders
// GFM tables as literal pipes. This module shapes agent replies into one
// or more Discord-safe chunks:
//   - `tablesToCodeBlocks(md)` — wrap GFM tables as fenced code blocks so
//     they render as monospace instead of literal pipes.
//   - `splitMessage(text, max)` — chunk at `max` chars on word boundaries,
//     preserving code-fence balance across chunk seams.
//   - `formatForDiscord(text, max)` — convenience: table-convert then split.

import { DISCORD_MESSAGE_MAX } from './constants.js';

const CODE_FENCE_RX = /```/g;

// Detect GFM tables: header row with at least one `|` separator, followed
// immediately by a separator row of `---` cells. Greedy capture of all
// subsequent table rows.
const GFM_TABLE_RX = /(?:^|\n)((?:\|[^\n]+\|\n)\|[\s:|-]+\|\n(?:\|[^\n]+\|(?:\n|$))+)/g;

export function tablesToCodeBlocks(md) {
  if (typeof md !== 'string' || md.length === 0) return md;
  return md.replace(GFM_TABLE_RX, (_match, table, offset) => {
    const trimmed = table.replace(/\n+$/, '');
    const prefix = offset === 0 ? '' : '\n';
    return `${prefix}\`\`\`\n${trimmed}\n\`\`\`\n`;
  });
}

function countFences(s) {
  return (s.match(CODE_FENCE_RX) ?? []).length;
}

// Pick a split boundary at-or-before `cap` that doesn't break a word.
// Prefer (in order): newline, space, hard cut at cap.
function pickSplitPoint(text, cap) {
  if (text.length <= cap) return text.length;
  let i = text.lastIndexOf('\n', cap);
  if (i > cap * 0.5) return i + 1; // include the newline in the prior chunk
  i = text.lastIndexOf(' ', cap);
  if (i > cap * 0.5) return i + 1;
  // No good boundary in the latter half — hard-cut at cap.
  return cap;
}

export function splitMessage(text, max = DISCORD_MESSAGE_MAX) {
  if (typeof text !== 'string') return [String(text ?? '')];
  if (text.length <= max) return [text];

  const chunks = [];
  let remaining = text;
  let openFence = false;

  while (remaining.length > max) {
    const cut = pickSplitPoint(remaining, max - (openFence ? 4 : 0));
    let head = remaining.slice(0, cut);
    const tail = remaining.slice(cut);

    // If we're inside an open fence at the start of this chunk, prefix with
    // ``` to reopen it.
    if (openFence) head = `\`\`\`\n${head}`;

    // Count fences in the *original* slice (without the synthetic reopen).
    const fences = countFences(remaining.slice(0, cut));
    const fenceBalance = fences % 2;
    if (fenceBalance === 1) {
      // Odd fence count → we split mid-fence. Close it, open it on the next chunk.
      head = `${head}\n\`\`\``;
      openFence = !openFence;
    }
    // If we were already inside a fence and this chunk has 0 fences, the
    // chunk is entirely fenced — close it and reopen on the next.
    if (openFence && fences === 0) {
      head = `${head}\n\`\`\``;
    }

    chunks.push(head);
    remaining = tail;
  }

  if (remaining.length > 0) {
    if (openFence) remaining = `\`\`\`\n${remaining}`;
    chunks.push(remaining);
  }

  return chunks;
}

export function formatForDiscord(text, max = DISCORD_MESSAGE_MAX) {
  const tablesOut = tablesToCodeBlocks(text);
  return splitMessage(tablesOut, max);
}
