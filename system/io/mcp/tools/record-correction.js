import { extractMNTokens, recordInsightFeedback } from '../../../cognition/briefing/feedback.js';
import { checkDurableWrite } from '../../../cognition/discretion/durable-write.js';
import { guardInboundContent } from '../../../cognition/discretion/inbound-guard.js';
import { recordEvent } from '../../capture/record-event.js';
import { surql } from 'surrealdb';

const NEGATIVE_PATTERNS = [
  /\bnot useful\b/i,
  /\bwasn['’]?t useful\b/i,
  /\bwrong\b/i,
  /\bmiss(ed)?\b/i,
  /\bbad\b/i,
  /\bdidn['’]?t (help|land)\b/i,
];
const POSITIVE_PATTERNS = [
  /\buseful\b/i,
  /\bgood\b/i,
  /\bhelpful\b/i,
  /\blanded\b/i,
  /\bspot ?on\b/i,
];

function inferVerdict(text) {
  if (typeof text !== 'string') return 'neutral';
  // Negative wins ties — corrections lean toward "bad".
  for (const p of NEGATIVE_PATTERNS) if (p.test(text)) return 'bad';
  for (const p of POSITIVE_PATTERNS) if (p.test(text)) return 'good';
  return 'neutral';
}

export function createRecordCorrectionTool({ db, embedder, processor }) {
  return {
    name: 'record_correction',
    description:
      "When the user corrects you — 'no, that's wrong', 'I prefer X' — call this. Robin learns from these corrections to avoid repeating mistakes.",
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 10000 },
        prior_response: { type: 'string' },
        meta: { type: 'object' },
        tool: { type: 'string' },
        action: { type: 'string' },
        rule_id: { type: 'string' },
        force: { type: 'boolean', default: false },
      },
      required: ['content'],
    },
    handler: async (args) => {
      // Guard: refuse to deactivate rules marked not_retractable.
      // The current handler doesn't deactivate rules via this path yet, but
      // the check is wired here so that any future retraction path encounters
      // the guard before writing active=false.
      if (args.rule_id) {
        // Fail-closed: a DB error reading the rule must NOT allow the
        // correction through. Otherwise a transient WS drop during the
        // retractability check could let a future retraction-path write
        // through the guard. Surface the error to the caller instead.
        const [rows] = await db
          .query(
            surql`SELECT meta FROM memos WHERE id = type::record('memos', ${args.rule_id}) LIMIT 1`,
          )
          .collect();
        const rule = Array.isArray(rows) ? rows[0] : rows;
        if (rule?.meta?.not_retractable === true) {
          return { ok: false, reason: 'rule_not_retractable', rule_id: args.rule_id };
        }
      }
      const gate = await checkDurableWrite(db, {
        destination: 'record_correction',
        text: args.content,
        sessionTaint: null,
        force: args.force === true,
      });
      if (!gate.ok) {
        return { ok: false, reason: 'outbound_blocked', blocked_by: gate.reason };
      }
      const meta = {
        kind: 'correction',
        ...(args.prior_response ? { prior_response: args.prior_response } : {}),
        ...(args.meta ?? {}),
      };
      const result = await recordEvent(db, embedder, {
        source: 'manual',
        content: args.content,
        meta,
        guard: guardInboundContent,
      });
      processor(result.id).catch((e) =>
        console.warn(
          `[record_correction] biographer enqueue failed for ${result.id}: ${e.message}`,
        ),
      );
      let demoted_class = null;
      if (args.tool && args.action) {
        const cls = `${args.tool}:${args.action}`;
        const { demoteOnCorrection } = await import('../../../cognition/jobs/action-trust.js');
        const r = await demoteOnCorrection(db, cls);
        if (r.demoted) demoted_class = cls;
      }

      // Auto-detect daily-brief insight feedback. When the correction mentions
      // [mN] tokens, fan out to recordInsightFeedback so the calibration loop
      // picks up the signal even when the user is correcting Robin via natural
      // language rather than the explicit CLI.
      const tokens = [
        ...extractMNTokens(args.content),
        ...extractMNTokens(args.prior_response ?? ''),
      ];
      const insightFeedback = [];
      const seen = new Set();
      for (const id of tokens) {
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          const verdict = inferVerdict(args.content);
          const fb = await recordInsightFeedback(db, {
            insightId: id,
            verdict,
            source: 'natural_language',
            freeText: args.content,
          });
          if (fb.ok) insightFeedback.push({ id, verdict, category: fb.category });
        } catch (e) {
          console.warn(`record_correction insight feedback failed for ${id}: ${e.message}`);
        }
      }

      return {
        id: String(result.id),
        demoted_class,
        ...(insightFeedback.length ? { insight_feedback: insightFeedback } : {}),
      };
    },
  };
}
