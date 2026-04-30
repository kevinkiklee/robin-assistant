const DISCORD_LIMIT = 2000;

export function stripMention(text, botUserId) {
  const re = new RegExp(`^\\s*<@!?${botUserId}>\\s*`);
  return text.replace(re, '').replace(/\s+$/, '');
}

export function splitMessage(text, limit = DISCORD_LIMIT) {
  if (!text || !text.trim()) return [];
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;
  let pending = ''; // chars to prepend to the next chunk (re-open a code fence)

  while (remaining.length > 0) {
    // Last chunk fast path: rest fits, including 4 reserved chars for a closing fence
    // if needed. (If only the no-close form fits, fall through to the splitting branch.)
    if (pending.length + remaining.length <= limit) {
      let chunk = pending + remaining;
      const fenceCount = (chunk.match(/```/g) || []).length;
      if (fenceCount % 2 !== 0) {
        if (chunk.length + 4 <= limit) {
          chunk = chunk + '\n```';
          chunks.push(chunk);
          remaining = '';
          pending = '';
          break;
        }
        // No room for closing fence — fall through to split.
      } else {
        chunks.push(chunk);
        remaining = '';
        pending = '';
        break;
      }
    }
    // Reserve 4 chars for a possible closing "\n```".
    const budget = limit - pending.length - 4;
    const cut = findCutIndex(remaining, budget);
    let chunk = pending + remaining.slice(0, cut);
    const fenceCount = (chunk.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
      chunk = chunk + '\n```';
      pending = '```\n';
    } else {
      pending = '';
    }
    chunks.push(chunk);
    remaining = remaining.slice(cut);
  }
  return chunks;
}

function findCutIndex(s, limit) {
  // 1) prefer a paragraph break (\n\n) within the budget
  const paraIdx = s.lastIndexOf('\n\n', limit);
  if (paraIdx > limit * 0.5 && fenceBalanced(s.slice(0, paraIdx + 2))) {
    return paraIdx + 2;
  }
  // 2) prefer a single newline within the budget
  const nlIdx = s.lastIndexOf('\n', limit);
  if (nlIdx > limit * 0.5 && fenceBalanced(s.slice(0, nlIdx + 1))) {
    return nlIdx + 1;
  }
  // 3) prefer a space within the budget, but only if balanced
  const spIdx = s.lastIndexOf(' ', limit);
  if (spIdx > limit * 0.5 && fenceBalanced(s.slice(0, spIdx + 1))) {
    return spIdx + 1;
  }
  // 4) hard cut at limit, or back up to most recent ``` if cutting would unbalance
  if (fenceBalanced(s.slice(0, limit))) return limit;
  return reFenceCut(s, limit);
}

function fenceBalanced(piece) {
  const opens = (piece.match(/```/g) || []).length;
  return opens % 2 === 0;
}

function reFenceCut(s, limit) {
  // Find the most recent ``` before limit. Cut just before it so the open fence
  // stays in the next chunk; the current chunk has only balanced fences.
  const lastFence = s.lastIndexOf('```', limit);
  return lastFence > 0 ? lastFence : limit;
}
