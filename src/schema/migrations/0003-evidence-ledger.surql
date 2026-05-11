-- ============================================================================
-- Theme 2a: evidence_ledger
-- Append-only corroborations / refutations per memo. Confidence becomes
-- derivable from this via fn::derived_confidence. Producers: reinforcement
-- loop, contradicts edge, biographer (optional), manual MCP (endorse/refute).
-- The stored memos.confidence stays as a cached value updated lazily by
-- dream's step-confidence-recompute.
-- ============================================================================

DEFINE TABLE evidence_ledger SCHEMAFULL TYPE NORMAL;
DEFINE FIELD memo_id      ON evidence_ledger TYPE record<memos>;
DEFINE FIELD source_event ON evidence_ledger TYPE option<record<events>>;
DEFINE FIELD source_memo  ON evidence_ledger TYPE option<record<memos>>;
DEFINE FIELD polarity     ON evidence_ledger TYPE string;
DEFINE FIELD weight       ON evidence_ledger TYPE float DEFAULT 1.0;
DEFINE FIELD reason       ON evidence_ledger TYPE string;
DEFINE FIELD ts           ON evidence_ledger TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta         ON evidence_ledger TYPE option<object> FLEXIBLE;
DEFINE INDEX evidence_memo_ts   ON evidence_ledger FIELDS memo_id, ts;
DEFINE INDEX evidence_polarity  ON evidence_ledger FIELDS memo_id, polarity;
DEFINE INDEX evidence_reason    ON evidence_ledger FIELDS reason;

-- Pseudocount-prior Beta-ish blend. Initial memo.confidence acts as a prior
-- weighted by prior_weight (default 3); evidence accumulates over time.
-- Bounded [0, 1].
DEFINE FUNCTION fn::derived_confidence($memo: record<memos>) {
  LET $m = $memo.*;
  LET $cor_w = (SELECT VALUE math::sum(weight) FROM evidence_ledger
                WHERE memo_id = $memo AND polarity = 'corroborates' GROUP ALL)[0] ?? 0;
  LET $ref_w = (SELECT VALUE math::sum(weight) FROM evidence_ledger
                WHERE memo_id = $memo AND polarity = 'refutes' GROUP ALL)[0] ?? 0;
  LET $prior_w = (SELECT VALUE value.prior_weight FROM runtime:evidence.config)[0] ?? 3.0;
  LET $num = $m.confidence * $prior_w + $cor_w;
  LET $den = $prior_w + $cor_w + $ref_w;
  RETURN math::min([1.0, math::max([0.0, $num / $den])]);
};

UPSERT runtime:`evidence.config` SET value = {
  prior_weight: 3.0,
  biographer_weight: 0.5,
  manual_weight: 2.0
};
