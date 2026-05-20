import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';

export interface SessionTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface SessionCapture {
  sessionId: string;
  turns: SessionTurn[];
  endedAt?: string;
}

export interface CaptureResult {
  captured: boolean;
  skipReason?: string;
  eventId?: number;
}

/** Apply skip rules and (if not skipped) write a 'session.captured' event for biographer to process. */
export async function captureSession(
  db: RobinDb,
  llm: LLMDispatcher | null,
  capture: SessionCapture,
): Promise<CaptureResult> {
  const userTurns = capture.turns.filter((t) => t.role === 'user' && t.content.trim());
  const assistantTurns = capture.turns.filter((t) => t.role === 'assistant' && t.content.trim());

  if (assistantTurns.length === 0) return { captured: false, skipReason: 'no_assistant_turn' };

  const allText = capture.turns
    .map((t) => t.content)
    .join('')
    .trim();
  if (allText.length === 0) return { captured: false, skipReason: 'empty_turn' };

  const hasNonToolAssistant = capture.turns.some(
    (t) => t.role === 'assistant' && t.content.trim().length > 0,
  );
  const onlyToolTurns = !hasNonToolAssistant && capture.turns.some((t) => t.role === 'tool');
  if (onlyToolTurns) return { captured: false, skipReason: 'pure_tool_turn' };

  const lastUserText = userTurns[userTurns.length - 1]?.content.trim() ?? '';
  if (lastUserText.length < 5 && /^(ok|yes|no|thanks|sure|cool|done)$/i.test(lastUserText)) {
    return { captured: false, skipReason: 'single_word_ack' };
  }

  // Dedup: hash the user turns; check recent events for a match
  const hash = Buffer.from(userTurns.map((t) => t.content).join('|'))
    .toString('base64')
    .slice(0, 64);
  const existing = db
    .prepare(`SELECT id FROM events WHERE kind = 'session.captured' AND payload LIKE ? LIMIT 1`)
    .get(`%"hash":"${hash}"%`);
  if (existing) return { captured: false, skipReason: 'dedup_hit' };

  const content = capture.turns.map((t) => `[${t.role.toUpperCase()}]\n${t.content}`).join('\n\n');

  const r = await ingest(db, llm, {
    kind: 'session.captured',
    source: 'capture',
    content,
    payload: { sessionId: capture.sessionId, hash, turnCount: capture.turns.length },
  });
  return { captured: true, eventId: r.eventId };
}
