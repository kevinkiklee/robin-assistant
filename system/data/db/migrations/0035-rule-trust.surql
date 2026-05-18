-- 0035-rule-trust.surql
-- Adds derived_from_trust to rule_candidates and rules.
-- Follows the same pattern as 0034-trust-propagation.surql.
-- Default 'trusted' preserves existing-row behavior.

DEFINE FIELD derived_from_trust ON rule_candidates TYPE string DEFAULT 'trusted';
DEFINE FIELD derived_from_trust ON rules           TYPE string DEFAULT 'trusted';

DEFINE INDEX rule_candidates_derived_from_trust ON rule_candidates FIELDS derived_from_trust;
DEFINE INDEX rules_derived_from_trust           ON rules           FIELDS derived_from_trust;
