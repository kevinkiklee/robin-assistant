-- 0028-rule-candidates-statement-kind-enum.surql
--
-- Adds 'statement_kind_enum' to the rule_candidates.kind ASSERT so that
-- step-prediction-taxonomy (cognition-e1 spec §4a) can write proposals for
-- new statement_kind enum entries through the standard candidate→approval flow.
--
-- No other tables or fields are affected.

DEFINE FIELD OVERWRITE kind ON rule_candidates TYPE string
  ASSERT $value IN [
    'behavior',
    'profile_update',
    'conflict_warning',
    'reinforce_behavior',
    'statement_kind_enum'
  ];
