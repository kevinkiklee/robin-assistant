// Discord message helpers — code-fence-aware chunker + mention stripper.
// Ported from robin-assistant-v1; both are pure string utilities.

import { DISCORD_MESSAGE_MAX } from './constants.js';

// Discord doesn't support GFM tables (`| a | b |` + `|---|---|`); they render
// as literal pipes. Convert each detected table to a fenced code block with
// space-padded columns, which Discord renders cleanly on web + mobile.
const TABLE_SEPARATOR = /^\|\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?\s*$/;
const CELL_STRIP_RE = /(\*\*|__|`)(.*?)\1/g;

function isTableRow(line) {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 2;
}

function splitRow(line) {
  // Strip leading/trailing pipe, split on unescaped `|`, trim cells.
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function stripInlineMarkup(cell) {
  // Discord drops markdown inside code fences, so `**x**` would render as
  // literal `**x**`. Unwrap the common wrappers; leave everything else.
  return cell.replace(CELL_STRIP_RE, '$2');
}

function renderTableAsCodeBlock(header, rows) {
  const cleanHeader = header.map(stripInlineMarkup);
  const cleanRows = rows.map((r) => r.map(stripInlineMarkup));
  const cols = cleanHeader.length;
  const widths = new Array(cols).fill(0);
  for (let i = 0; i < cols; i++) widths[i] = [...cleanHeader[i]].length;
  for (const r of cleanRows) {
    for (let i = 0; i < cols; i++) {
      const cell = r[i] ?? '';
      const w = [...cell].length;
      if (w > widths[i]) widths[i] = w;
    }
  }
  const pad = (cell, w) => {
    const len = [...cell].length;
    return cell + ' '.repeat(Math.max(0, w - len));
  };
  const fmt = (cells) =>
    cells
      .map((c, i) => pad(c ?? '', widths[i]))
      .join('  ')
      .replace(/\s+$/, '');
  const lines = [fmt(cleanHeader), ...cleanRows.map(fmt)];
  return '```\n' + lines.join('\n') + '\n```';
}

// Detect GFM-style tables (strict form with leading/trailing `|` and a
// `|---|---|` separator on line 2) and replace each with a fenced code block.
// Non-table content is returned unchanged. Idempotent on input that contains
// no tables.
export function tablesToCodeBlocks(text) {
  if (!text || text.indexOf('|') === -1) return text ?? '';
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (
      !inFence &&
      isTableRow(line) &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[i + 1].trim())
    ) {
      const header = splitRow(line);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      out.push(renderTableAsCodeBlock(header, rows));
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

// Apply Discord-specific transforms to outbound text. Currently only table
// conversion, but this is the seam to add more (e.g. mention escaping) later.
export function formatForDiscord(text) {
  return tablesToCodeBlocks(text);
}

export function stripMention(text, botUserId) {
  if (!text || !botUserId) return text ?? '';
  const re = new RegExp(`^\\s*<@!?${botUserId}>\\s*`);
  return text.replace(re, '').replace(/\s+$/, '');
}

// Split text into Discord-safe chunks (≤ DISCORD_MESSAGE_MAX each) while
// keeping triple-backtick code fences balanced across chunk boundaries.
// Returns [] for empty input.
export function splitMessage(text, limit = DISCORD_MESSAGE_MAX) {
  if (!text || !text.trim()) return [];
  if ([...text].length <= limit) return [text];

  const chunks = [];
  let remaining = text;
  let pending = '';

  const CLOSE_FENCE = '\n' + '```';
  const REOPEN_FENCE = '```' + '\n';
  while (remaining.length > 0) {
    if (pending.length + remaining.length <= limit) {
      const chunk = pending + remaining;
      const opens = (chunk.match(/```/g) || []).length;
      if (opens % 2 !== 0) {
        if (chunk.length + CLOSE_FENCE.length <= limit) {
          chunks.push(chunk + CLOSE_FENCE);
          break;
        }
      } else {
        chunks.push(chunk);
        break;
      }
    }
    const budget = limit - pending.length - CLOSE_FENCE.length;
    const cut = findCutIndex(remaining, budget);
    let chunk = pending + remaining.slice(0, cut);
    const opens = (chunk.match(/```/g) || []).length;
    if (opens % 2 !== 0) {
      chunk = chunk + CLOSE_FENCE;
      pending = REOPEN_FENCE;
    } else {
      pending = '';
    }
    chunks.push(chunk);
    remaining = remaining.slice(cut);
  }
  return chunks;
}

function findCutIndex(s, limit) {
  const paraIdx = s.lastIndexOf('\n\n', limit);
  if (paraIdx > limit * 0.5 && fenceBalanced(s.slice(0, paraIdx + 2))) return paraIdx + 2;
  const nlIdx = s.lastIndexOf('\n', limit);
  if (nlIdx > limit * 0.5 && fenceBalanced(s.slice(0, nlIdx + 1))) return nlIdx + 1;
  const spIdx = s.lastIndexOf(' ', limit);
  if (spIdx > limit * 0.5 && fenceBalanced(s.slice(0, spIdx + 1))) return spIdx + 1;
  if (fenceBalanced(s.slice(0, limit))) return limit;
  const lastFence = s.lastIndexOf('```', limit);
  return lastFence > 0 ? lastFence : limit;
}

function fenceBalanced(piece) {
  return (piece.match(/```/g) || []).length % 2 === 0;
}

// Compute a structured origin string for a Discord reply destination. Used
// by the outbound policy's trusted-origin bypass (Layer-1 taint), so the user
// can list whole guilds / DMs as trusted without naming every channel.
//
//   DM       → `discord:dm:<userId>`
//   channel  → `discord:guild:<guildId>:channel:<channelId>`
//   thread   → `discord:guild:<guildId>:channel:<parentId>:thread:<threadId>`
//
// Returns null when the target is unrecognizable (defensive — caller will
// fall back to the destination string).
export function originForTarget(target, userId) {
  if (!target) return null;
  if (typeof target.isThread === 'function' && target.isThread()) {
    const parent = target.parentId ?? target.parent?.id;
    if (target.guildId && parent && target.id) {
      return `discord:guild:${target.guildId}:channel:${parent}:thread:${target.id}`;
    }
  }
  if (target.guildId && target.id) {
    return `discord:guild:${target.guildId}:channel:${target.id}`;
  }
  // DM channel: prefer the recipient on the channel itself, fall back to the
  // user id we were given.
  const recipientId = target.recipient?.id ?? userId;
  if (recipientId) return `discord:dm:${recipientId}`;
  return null;
}

// Build a thread title from the user's first message: strip the bot mention,
// collapse whitespace, slice by code points so we never cut a surrogate pair.
// Falls back to 'Robin' if the cleaned text is empty.
export function threadTitleFrom(text, botUserId, max = 50) {
  const cleaned = stripMention(text ?? '', botUserId)
    .trim()
    .replace(/\s+/g, ' ');
  if (!cleaned) return 'Robin';
  const codePoints = [...cleaned];
  return codePoints.length <= max ? cleaned : codePoints.slice(0, max).join('');
}
