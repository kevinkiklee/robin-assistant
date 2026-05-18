import { surql } from 'surrealdb';
import { listPendingEvents } from '../../../cognition/biographer/pending-events.js';
import { validateTaskType } from '../../../cognition/introspection/task-taxonomy.js';
import { inferCorrection } from '../../../cognition/intuition/correction-inference.js';
import { readFileTail } from '../../../config/file-tail.js';
import { recordEvent } from '../../../io/capture/record-event.js';
import { captureFromTranscript } from '../../../io/capture/session-capture.js';
import { isSelfImprovementV2Enabled } from '../../config/self-improvement-v2.js';

// ---------------------------------------------------------------------------
// Minimal transcript parser for correction-inference context.
//
// Extracts:
//   currentUserText    — the human-typed user message that triggered the
//                        current (just-completed) assistant turn
//   priorAssistantTurn — the assistant turn immediately BEFORE currentUserText,
//                        with { text, tool_calls: [{name}] }
//
// This is intentionally separate from extractTurns() in transcript.js, which
// returns the *latest* assistant turn. For correction-inference we need the
// turn one position further back (what the user may be correcting).
// ---------------------------------------------------------------------------
const CORRECTION_TAIL_BYTES = 64 * 1024;

function _pickRole(obj) {
  return obj?.role ?? obj?.message?.role ?? null;
}

function _pickContent(obj) {
  if (obj?.content !== undefined) return obj.content;
  if (obj?.message?.content !== undefined) return obj.message.content;
  return null;
}

function _readTextAndToolCalls(content) {
  if (typeof content === 'string') {
    return { text: content, toolCallNames: [], hasToolResultOnly: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', toolCallNames: [], hasToolResultOnly: false };
  }
  const parts = [];
  const names = [];
  let hasToolResult = false;
  let hasText = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      hasText = true;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      names.push(block.name);
    } else if (block.type === 'tool_result' || block.type === 'function_response') {
      hasToolResult = true;
    }
  }
  return {
    text: parts.join('\n'),
    toolCallNames: names,
    hasToolResultOnly: hasToolResult && !hasText && names.length === 0,
  };
}

function _parseJsonlLines(raw) {
  const lines = raw.split('\n');
  const parsed = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // skip malformed / partial lines
    }
  }
  return parsed;
}

/**
 * Extract correction-inference context from a transcript file.
 *
 * Returns:
 *   { currentUserText: string|null, priorAssistantTurn: {text, tool_calls}|null }
 *
 * currentUserText    = latest human-typed user message (potential correction)
 * priorAssistantTurn = the assistant turn before currentUserText (potential antecedent)
 *
 * At Stop hook time the transcript tail looks like:
 *   …[prior_assistant] → [current_user] → [current_assistant (just generated)]
 * We want prior_assistant and current_user.
 */
function extractCorrectionContext(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return { currentUserText: null, priorAssistantTurn: null };
  }
  const raw = readFileTail(transcriptPath, CORRECTION_TAIL_BYTES);
  if (!raw) return { currentUserText: null, priorAssistantTurn: null };

  const msgs = _parseJsonlLines(raw);
  if (msgs.length === 0) return { currentUserText: null, priorAssistantTurn: null };

  // Step 1: skip the latest assistant turn (the current response being processed).
  let idx = msgs.length - 1;
  while (idx >= 0 && _pickRole(msgs[idx]) !== 'assistant') idx--;
  // idx now points at the latest assistant message (or -1 if none).
  if (idx < 0) return { currentUserText: null, priorAssistantTurn: null };

  // Step 2: find the human user message immediately before the latest assistant
  //         (skipping pure tool_result user messages).
  let currentUserText = null;
  let userIdx = idx - 1;
  while (userIdx >= 0) {
    if (_pickRole(msgs[userIdx]) !== 'user') {
      userIdx--;
      continue;
    }
    const { text, hasToolResultOnly } = _readTextAndToolCalls(_pickContent(msgs[userIdx]));
    if (hasToolResultOnly || text.length === 0) {
      userIdx--;
      continue;
    }
    currentUserText = text;
    break;
  }

  if (currentUserText === null) return { currentUserText: null, priorAssistantTurn: null };

  // Step 3: find the prior assistant turn (before the current user message).
  let priorAssistantTurn = null;
  let priorIdx = userIdx - 1;
  while (priorIdx >= 0) {
    if (_pickRole(msgs[priorIdx]) !== 'assistant') {
      priorIdx--;
      continue;
    }
    const { text, toolCallNames } = _readTextAndToolCalls(_pickContent(msgs[priorIdx]));
    priorAssistantTurn = {
      text,
      tool_calls: toolCallNames.map((name) => ({ name })),
    };
    break;
  }

  return { currentUserText, priorAssistantTurn };
}

// Minimal FNV-1a-style hash for content_hash on task_outcome memos
// (same pattern as queue-poller.js — no crypto needed, just a stable dedup key).
function _hashLite(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export const biographerRoutes = [
  {
    method: 'POST',
    path: '/internal/biographer/process-pending',
    async handler({ ctx, body }) {
      // Correction-inference pre-step (fail-soft, gated on runtime:self-improvement-v2).
      // Runs BEFORE captureFromTranscript so the explicit_correction event
      // is in the DB before the biographer drains pending rows.
      if (body && typeof body.transcript_path === 'string' && body.transcript_path.length > 0) {
        try {
          const v2Enabled = await isSelfImprovementV2Enabled(ctx.db);
          if (v2Enabled) {
            const { currentUserText, priorAssistantTurn } = extractCorrectionContext(
              body.transcript_path,
            );
            if (currentUserText) {
              const verdict = inferCorrection({
                userText: currentUserText,
                priorTurn: priorAssistantTurn ?? { text: '', tool_calls: [] },
              });
              if (verdict.fires) {
                // Determine task_type: prefer caller-supplied body.task_type
                // (populated by outbound writes and job runners), fall back to
                // the generic default. validateTaskType guards against
                // free-form values from untrusted body fields.
                let taskType = 'turn:default';
                const rawTaskType = body.task_type ?? null;
                if (rawTaskType) {
                  const v = validateTaskType(rawTaskType);
                  if (v.ok) taskType = rawTaskType;
                }

                // 1. Write events:explicit_correction row.
                let correctionEventId = null;
                try {
                  const { id } = await recordEvent(ctx.db, ctx.embedder.wrap, {
                    source: 'explicit_correction',
                    content: currentUserText,
                    meta: {
                      matched_pattern: verdict.signals?.matched_pattern ?? true,
                      antecedent: verdict.signals?.antecedent ?? {},
                      session_id: body.session_id ?? body.sessionId ?? null,
                    },
                  });
                  correctionEventId = String(id);
                } catch (e) {
                  console.warn(
                    `[correction-inference] explicit_correction write failed: ${e.message}`,
                  );
                }

                // 2. Write task_outcome memo.
                // Direct DB write (no embedder needed for task_outcome memos).
                try {
                  const memoContent = `explicit correction detected (task_type=${taskType})`;
                  await ctx.db
                    .query(
                      surql`CREATE memos CONTENT ${{
                        kind: 'task_outcome',
                        content: memoContent,
                        content_hash: _hashLite(memoContent),
                        derived_by: 'correction-inference',
                        meta: {
                          task_type: taskType,
                          task_id: correctionEventId ?? 'unknown',
                          source_event: correctionEventId,
                          signals: {
                            explicit_correction: {
                              text: currentUserText,
                            },
                          },
                          score: 0,
                        },
                        scope: 'global',
                        tags: [],
                      }}`,
                    )
                    .collect();
                } catch (e) {
                  console.warn(`[correction-inference] task_outcome write failed: ${e.message}`);
                }
              }
            }
          }
        } catch (e) {
          // Never block the biographer pipeline on correction-inference failure.
          console.warn(`[correction-inference] pre-step failed: ${e.message}`);
        }
      }

      // Capture pre-step (fail-soft). When the Stop hook forwards
      // transcript_path, read the latest turn and write a conversation
      // event before draining pending — biographer then processes it
      // alongside any other pending rows.
      if (body && typeof body.transcript_path === 'string' && body.transcript_path.length > 0) {
        try {
          await captureFromTranscript(ctx.db, ctx.embedder.wrap, {
            transcriptPath: body.transcript_path,
            sessionId: body.session_id ?? body.sessionId ?? null,
            host: ctx.host?.name ?? null,
          });
        } catch (e) {
          console.error(`daemon capture pre-step failed: ${e.message}`);
        }
      }
      // C1: Refresh batch_config snapshot before draining so operator changes
      // to runtime:biographer.value.batch_config take effect at flush time.
      if (ctx.accumulator?.refreshConfig) {
        await ctx.accumulator.refreshConfig();
      }
      const pendingRows = await listPendingEvents(ctx.db, { limit: 50 });
      for (const row of pendingRows) {
        try {
          if (ctx.accumulator?.add) {
            ctx.accumulator.add(String(row.id), String(row.source ?? 'cli'));
          } else {
            // Defensive: pre-C1 single-id path if the accumulator is somehow
            // unwired (should not happen in production boots).
            ctx.queue.enqueue(String(row.id)).catch(() => {});
          }
        } catch (e) {
          console.warn(`[biographer] accumulator.add failed for ${row.id}: ${e.message}`);
        }
      }
      return { enqueued: pendingRows.length };
    },
  },
];
