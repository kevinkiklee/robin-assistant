import { readFileTail } from '../runtime/file-tail.js';

const DEFAULT_TAIL_BYTES = 32 * 1024;

const EMPTY = { userText: null, assistantText: null, hasToolCalls: false, tsAssistant: null };

// Return the concatenated text from a message's content field.
// Content can be a bare string OR an array of content blocks. For arrays
// we extract only `text`-type blocks. `tool_use`, `tool_result`, and
// `thinking` blocks do not contribute to the returned string.
//
// Side-channel: returns `{ text, hasToolCalls, hasToolResultOnly }`
// so the caller can tell tool-call turns from text turns and skip
// user-role messages that are pure tool_result returns.
function readContent(content) {
  if (typeof content === 'string') {
    return { text: content, hasToolCalls: false, hasToolResultOnly: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', hasToolCalls: false, hasToolResultOnly: false };
  }
  const parts = [];
  let hasToolCalls = false;
  let hasText = false;
  let hasToolResult = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      hasText = true;
    } else if (block.type === 'tool_use') {
      hasToolCalls = true;
    } else if (block.type === 'tool_result' || block.type === 'function_response') {
      hasToolResult = true;
    }
  }
  return {
    text: parts.join('\n'),
    hasToolCalls,
    hasToolResultOnly: hasToolResult && !hasText,
  };
}

function parseJsonlBackwards(tail) {
  if (typeof tail !== 'string' || tail.length === 0) return [];
  const lines = tail.split('\n');
  // The first line of a tail read may be a partial fragment if the file was
  // larger than tailBytes (read started mid-line). Try to parse it — if it
  // fails, skip it. All subsequent lines are either complete or the malformed
  // final line (which we also skip individually below).
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // First line: silently skip (likely a partial tail fragment).
      // Other lines: also skip (e.g. partial final write mid-flush).
    }
  }
  return parsed;
}

function pickRole(obj) {
  return obj?.role ?? obj?.message?.role ?? null;
}

function pickContent(obj) {
  if (obj?.content !== undefined) return obj.content;
  if (obj?.message?.content !== undefined) return obj.message.content;
  return null;
}

function pickAssistantTs(obj) {
  const raw = obj?.ts ?? obj?.message?.ts ?? obj?.timestamp ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function extractTurns({ transcriptPath, tailBytes } = {}) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return { ...EMPTY };
  const tail = readFileTail(transcriptPath, tailBytes ?? DEFAULT_TAIL_BYTES);
  if (!tail) return { ...EMPTY };
  const msgs = parseJsonlBackwards(tail);
  if (msgs.length === 0) return { ...EMPTY };

  // Walk backwards: find the latest assistant message with text content.
  let assistantIdx = -1;
  let assistantText = null;
  let hasToolCalls = false;
  let tsAssistant = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (pickRole(msgs[i]) !== 'assistant') continue;
    const { text, hasToolCalls: tc } = readContent(pickContent(msgs[i]));
    // Accept any assistant message (including empty-text + tool_use only)
    // as the anchor — the orchestrator's skip rules decide whether to keep it.
    assistantIdx = i;
    assistantText = text.length > 0 ? text : tc ? '' : null;
    hasToolCalls = tc;
    tsAssistant = pickAssistantTs(msgs[i]);
    break;
  }
  if (assistantIdx === -1 || assistantText === null) return { ...EMPTY };

  // Walk backwards from the assistant message to find the human user prompt,
  // skipping any user-role messages that are pure tool_result returns.
  let userText = null;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (pickRole(msgs[i]) !== 'user') continue;
    const { text, hasToolResultOnly } = readContent(pickContent(msgs[i]));
    if (hasToolResultOnly) continue;
    if (text.length === 0) continue;
    userText = text;
    break;
  }

  return { userText, assistantText, hasToolCalls, tsAssistant };
}
