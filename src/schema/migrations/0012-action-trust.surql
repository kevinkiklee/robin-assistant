-- 0012-action-trust.surql — per-(tool, action_template) trust ledger.
DEFINE TABLE action_trust SCHEMAFULL;
DEFINE FIELD class            ON action_trust TYPE string;
DEFINE FIELD state            ON action_trust TYPE string ASSERT $value IN ['AUTO', 'ASK', 'NEVER'];
DEFINE FIELD set_by           ON action_trust TYPE string ASSERT $value IN ['user', 'correction', 'default'];
DEFINE FIELD success_count    ON action_trust TYPE int DEFAULT 0;
DEFINE FIELD correction_count ON action_trust TYPE int DEFAULT 0;
DEFINE FIELD last_used_at     ON action_trust TYPE option<datetime>;
DEFINE FIELD last_state_change_at ON action_trust TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at       ON action_trust TYPE datetime VALUE time::now();
DEFINE INDEX action_trust_class ON action_trust FIELDS class UNIQUE;
