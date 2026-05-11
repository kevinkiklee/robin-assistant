-- ============================================================================
-- Theme 2b: action_trust_ledger
-- Audit history + decay + consecutive-failure escalation for action_trust.
-- Flat action_trust table stays as hot-path cache; ledger is source of truth
-- for state changes.
-- ============================================================================

DEFINE TABLE action_trust_ledger SCHEMAFULL TYPE NORMAL;
DEFINE FIELD class       ON action_trust_ledger TYPE string;
DEFINE FIELD old_state   ON action_trust_ledger TYPE option<string>;
DEFINE FIELD new_state   ON action_trust_ledger TYPE option<string>;
DEFINE FIELD kind        ON action_trust_ledger TYPE string;
DEFINE FIELD set_by      ON action_trust_ledger TYPE string;
DEFINE FIELD reason      ON action_trust_ledger TYPE option<string>;
DEFINE FIELD ts          ON action_trust_ledger TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON action_trust_ledger TYPE option<object> FLEXIBLE;
DEFINE INDEX atl_class_ts ON action_trust_ledger FIELDS class, ts;
DEFINE INDEX atl_kind     ON action_trust_ledger FIELDS kind;

UPSERT runtime:`action_trust.config` SET value = {
  decay_days: 90,
  consecutive_corrections_to_block: 3,
  default_state: 'ASK'
};
