import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { surql } from 'surrealdb';
import { sha256 } from '../embed/hash.js';
import { guardInboundContent } from '../hooks/inbound-guard.js';
import { paths } from '../runtime/data-store.js';
import { RobinPiiRefusedError } from './errors.js';
import { recordEvent } from './record-event.js';
import { extractTurns } from './transcript.js';

const ACK_WORDS = new Set([
  'ok',
  'okay',
  'yes',
  'no',
  'thanks',
  'thank you',
  'continue',
  'go',
  'go ahead',
  'next',
  'sure',
  'done',
]);

const SIDE_CAP_BYTES = 8 * 1024;
const TOTAL_CAP_BYTES = 16 * 1024;
const PURE_TOOL_MIN_CHARS = 30;
const EMPTY_MIN_CHARS = 8;

function trimToBytes(s, max) {
  if (typeof s !== 'string') return '';
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  // Fast char-based truncate; we only need to be near the budget for biographer.
  return s.slice(0, max);
}

function formatContent(userText, assistantText) {
  const u = trimToBytes(userText ?? '(no user prompt)', SIDE_CAP_BYTES);
  const a = trimToBytes(assistantText ?? '', SIDE_CAP_BYTES);
  const out = `USER: ${u}\n\nASSISTANT: ${a}`;
  return trimToBytes(out, TOTAL_CAP_BYTES);
}

async function logSkip({ rule, sessionId, userLen, assistantLen }) {
  try {
    const dir = paths.data.logs();
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'capture_skip',
      session_id: sessionId ?? null,
      rule,
      user_len: userLen,
      assistant_len: assistantLen,
    });
    await appendFile(join(dir, 'biographer.log'), `${line}\n`, 'utf8');
  } catch {
    // never block capture on log failure
  }
}

export async function captureFromTranscript(
  db,
  embedder,
  { transcriptPath, sessionId, host } = {},
) {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    await logSkip({ rule: 'no_transcript_path', sessionId, userLen: 0, assistantLen: 0 });
    return { captured: false, skippedReason: 'no_transcript_path' };
  }

  const { userText, assistantText, hasToolCalls, tsAssistant } = extractTurns({ transcriptPath });
  const userTrim = (userText ?? '').trim();
  const assistantTrim = (assistantText ?? '').trim();
  const userLen = userTrim.length;
  const assistantLen = assistantTrim.length;
  const combinedLen = userLen + assistantLen;

  if (assistantText === null) {
    await logSkip({ rule: 'no_assistant_turn', sessionId, userLen, assistantLen });
    return { captured: false, skippedReason: 'no_assistant_turn' };
  }

  if (userText !== null && ACK_WORDS.has(userTrim.toLowerCase())) {
    await logSkip({ rule: 'single_word_ack', sessionId, userLen, assistantLen });
    return { captured: false, skippedReason: 'single_word_ack' };
  }

  if (hasToolCalls && combinedLen < PURE_TOOL_MIN_CHARS) {
    await logSkip({ rule: 'pure_tool_turn', sessionId, userLen, assistantLen });
    return { captured: false, skippedReason: 'pure_tool_turn' };
  }

  if (combinedLen < EMPTY_MIN_CHARS) {
    await logSkip({ rule: 'empty_turn', sessionId, userLen, assistantLen });
    return { captured: false, skippedReason: 'empty_turn' };
  }

  const content = formatContent(userText, assistantText);
  const content_hash = sha256(content);

  const [hits] = await db
    .query(
      surql`SELECT id FROM events WHERE source = 'conversation' AND content_hash = ${content_hash} LIMIT 1`,
    )
    .collect();
  if (hits.length > 0) {
    await logSkip({ rule: 'dedup_hit', sessionId, userLen, assistantLen });
    return { captured: false, skippedReason: 'dedup_hit' };
  }

  try {
    const { id } = await recordEvent(db, embedder, {
      source: 'conversation',
      content,
      ts: tsAssistant ?? undefined,
      meta: {
        session_id: sessionId ?? null,
        host: host ?? null,
        has_tool_calls: hasToolCalls,
      },
      guard: guardInboundContent,
    });
    return { captured: true, eventId: String(id) };
  } catch (e) {
    if (e instanceof RobinPiiRefusedError) {
      await logSkip({ rule: 'pii_refused', sessionId, userLen, assistantLen });
      return { captured: false, skippedReason: 'pii_refused' };
    }
    throw e;
  }
}
