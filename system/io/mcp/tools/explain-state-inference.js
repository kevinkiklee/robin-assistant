// explain-state-inference.js — Cognition D1 / Theme 4 introspection. Read-only.
//
// Returns:
//   current        latest non-superseded state_inference memo for the source
//                  (or for all sources if source is omitted, taking the
//                  highest derived_at across sources).
//   history        up to 10 hops of <-supersedes chain from current.
//   evidence_replay  ledger rows for every memo in history (chronological).
//
// Private-scope memos return only { private: true, id, derived_at }.

import { BoundQuery } from 'surrealdb';
import { isOutboundBlocked } from '../../../cognition/memory/scope-registry.js';

const HISTORY_HOPS = 10;

function redactIfPrivate(memo) {
  if (memo?.scope && isOutboundBlocked(memo.scope)) {
    return { private: true, id: String(memo.id), derived_at: memo.derived_at };
  }
  return {
    id: String(memo.id),
    content: memo.content,
    confidence: memo.confidence,
    derived_at: memo.derived_at,
    scope: memo.scope,
    meta: memo.meta,
  };
}

export function createExplainStateInferenceTool({ db }) {
  return {
    name: 'explain_state_inference',
    description:
      'Theme 4 introspection. Returns the latest state_inference memo for a source (or the freshest across all sources), plus its supersedes chain (up to 10 hops) and ledger rows. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: "e.g. 'agent:claude-code'" },
      },
    },
    handler: async ({ source } = {}) => {
      // current (most-recent non-superseded for source, or globally).
      const whereSource = source ? `AND meta.source = $source` : '';
      const [curRows] = await db
        .query(
          new BoundQuery(
            `SELECT id, content, confidence, derived_at, scope, meta FROM memos
             WHERE kind = 'state_inference' AND count(<-supersedes) = 0 ${whereSource}
             ORDER BY derived_at DESC LIMIT 1`,
            source ? { source } : {},
          ),
        )
        .collect();
      const cur = curRows?.[0];
      if (!cur) {
        return { current: null, history: [], evidence_replay: [] };
      }

      // history: walk <-supersedes from cur (up to HISTORY_HOPS).
      const history = [];
      let frontier = cur.id;
      for (let i = 0; i < HISTORY_HOPS; i++) {
        const [hops] = await db
          .query(
            new BoundQuery(
              `SELECT VALUE in FROM edges WHERE kind = 'supersedes' AND out = $id LIMIT 1`,
              { id: frontier },
            ),
          )
          .collect();
        const priorId = hops?.[0];
        if (!priorId) break;
        const [memoRows] = await db
          .query(
            new BoundQuery(
              `SELECT id, content, confidence, derived_at, scope, meta FROM ONLY $id`,
              { id: priorId },
            ),
          )
          .collect();
        const memo = memoRows?.[0] ?? memoRows;
        if (!memo) break;
        history.push(redactIfPrivate(memo));
        frontier = memo.id;
      }

      // evidence_replay: ledger rows for cur + every memo in history.
      const refs = [cur.id, ...history.map((h) => h.id)];
      const [ledger] = await db
        .query(
          new BoundQuery(
            `SELECT memo_id, polarity, reason, weight, ts FROM evidence_ledger
             WHERE memo_id IN $refs ORDER BY ts ASC`,
            { refs },
          ),
        )
        .collect();

      return {
        current: redactIfPrivate(cur),
        history,
        evidence_replay: ledger ?? [],
      };
    },
  };
}
