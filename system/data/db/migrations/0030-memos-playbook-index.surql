-- 0030-memos-playbook-index.surql
--
-- Adds a compound index on memos for the active-playbook lookup hot path.
-- Without it, fetchActivePlaybook in system/cognition/intuition/playbook-inject.js
-- and explain_playbook in MCP-tools both scan the full memos table once the
-- memos table grows in Phase 2.

DEFINE INDEX memos_playbook_task_type_active ON memos FIELDS kind, meta.task_type, meta.active;
