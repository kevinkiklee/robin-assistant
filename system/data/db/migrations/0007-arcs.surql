-- ============================================================================
-- Theme 1b: arcs (multi-episode containers) + episode lifecycle additions
-- ============================================================================

DEFINE TABLE arcs SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name             ON arcs TYPE option<string>;
DEFINE FIELD summary          ON arcs TYPE option<string>;
DEFINE FIELD started_at       ON arcs TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD last_activity_at ON arcs TYPE datetime DEFAULT time::now();
DEFINE FIELD ended_at         ON arcs TYPE option<datetime>;
DEFINE FIELD status           ON arcs TYPE string DEFAULT 'active';
DEFINE FIELD scope            ON arcs TYPE string DEFAULT 'global';
DEFINE FIELD tags             ON arcs TYPE array<string> DEFAULT [];
DEFINE FIELD entity_ids       ON arcs TYPE array<record<entities>> DEFAULT [];
DEFINE FIELD meta             ON arcs TYPE option<object> FLEXIBLE;
DEFINE INDEX arcs_status        ON arcs FIELDS status;
DEFINE INDEX arcs_last_activity ON arcs FIELDS last_activity_at;
DEFINE INDEX arcs_name_fts      ON arcs FIELDS name    FULLTEXT ANALYZER english BM25 HIGHLIGHTS;
DEFINE INDEX arcs_summary_fts   ON arcs FIELDS summary FULLTEXT ANALYZER english BM25 HIGHLIGHTS;

-- Episodes get last_event_at + summary_log for stale-sweep + incremental summary.
DEFINE FIELD last_event_at ON episodes TYPE option<datetime>;
DEFINE FIELD summary_log   ON episodes TYPE array<string> DEFAULT [];
DEFINE INDEX episodes_last_event_at ON episodes FIELDS last_event_at;

UPSERT runtime:`arc.config` SET value = {
  auto_create_enabled: true,
  min_episodes: 2,
  min_shared_entities: 3,
  dedup_jaccard_threshold: 0.7,
  pause_after_idle_days: 14,
  close_after_idle_days: 60,
  name_derive_from_top_n_entities: 3
};

UPSERT runtime:`episode.config` SET value = {
  summary_log_size: 20,
  idle_minutes_by_source: {
    'claude-code': 360,
    gemini: 360,
    integration: 1440,
    default_source: 720
  }
};
