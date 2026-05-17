// inference-rules.js — constants used by correction-inference.js and the
// introspection faculty's structural outcome inference.
// Pure data — no DB calls, no I/O.

// Regex patterns for correction-inference (spec §5).
// Anchored at start of message.
export const CORRECTION_REGEXES = [
  /^(no|nope|wrong|actually|wait|instead|i meant|i mean)\b/i,
  /^\d+\.?\s*(no|not)\b/i,
  /^[a-e]\.?$/i, // single-letter override after a multi-option AskUserQuestion
];

// Antecedent classification (spec §5). One match required:
//   - STRONG: AskUserQuestion call OR predict() call in prior turn
//   - WEAK:   numbered list >=2 items, ends in '?', performed outbound write
// Fires when >=1 STRONG match OR >=2 WEAK matches.
export const ANTECEDENT_KINDS = {
  STRONG: ['ask_user_question_call', 'predict_call'],
  WEAK: ['numbered_list_ge2', 'ends_with_question_mark', 'outbound_write_performed'],
};

// Outcome inference time windows (seconds).
export const OUTCOME_INFERENCE_WINDOWS = {
  correction_followup_window_sec: 600, // 10 min
  // v1.5 (deferred): reask_window_sec_discord 300, reask_window_sec_terminal 1, abandoned_thread_sec 1800
};

// Outcome inference scores (spec §2).
export const OUTCOME_INFERENCE_SCORES = {
  outbound_blocked: 0.2,
  recall_fingerprint_reuse: 0.3,
  explicit_correction: 0.0,
};

// Introspection budget knobs (spec §2 / §6 defaults — KV overrides at runtime).
export const INTROSPECTION_DEFAULTS = {
  daily_cost_budget_usd: 0.5,
  turn_sample_pct_floor: 5,
  turn_sample_pct_ceiling: 50,
  target_turn_spend_fraction: 0.5, // half of daily budget reserved for turns
  budget_remaining_thresholds: {
    recall_throttle_at: 0.25,
    antecedent_regex_fallback_at: 0.25,
    turn_sample_cutoff_at: 0.1,
  },
  leaky_bucket_decay_per_sec: 1 / 60,
  crash_count_restart_threshold: 5,
};
