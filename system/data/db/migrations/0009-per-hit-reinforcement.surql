-- ============================================================================
-- Cognition B1 — per-hit reinforcement attribution
-- ============================================================================
-- recall_log.ranked_hits[*] is already TYPE object FLEXIBLE (0001-init.surql
-- line 298), so the new per-hit keys `used`, `used_via`, `used_score` need no
-- additional DEFINE FIELD. We add two top-level optional fields plus an
-- index, extend the outcome enum, and seed the runtime config singleton
-- in 'off' mode (rollout flips it to 'hybrid' separately).
-- ============================================================================

DEFINE FIELD reply_event_id ON recall_log TYPE option<record<events>>;
DEFINE FIELD attribution    ON recall_log TYPE option<object> FLEXIBLE;
DEFINE INDEX recall_log_reply ON recall_log FIELDS reply_event_id;

REMOVE FIELD outcome ON recall_log;
DEFINE FIELD outcome ON recall_log TYPE string DEFAULT 'pending'
  ASSERT $value IN ['pending', 'reinforced', 'corrected', 'evaluated_no_signal', 'evaluated_no_used'];

UPSERT runtime:`reinforcement.config` SET value = {
  attribution_mode: 'off',
  similarity_threshold: 0.35,
  jaccard_min_overlap_tokens: 2,
  citation_date_window_days: 2,
  fallback_when_no_reply: true,
  fallback_when_zero_used: true,
  reply_lookup_window_ms: 600000
};
