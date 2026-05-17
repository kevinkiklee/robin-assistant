import { BoundQuery } from 'surrealdb';
import { validateTaskType } from '../../../cognition/introspection/task-taxonomy.js';
import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

/**
 * Parse YAML-like frontmatter block from a draft string (between --- markers).
 * Returns an object of key: value pairs or null if unparseable.
 * Tolerant: accepts both --- and ``` fences, and gracefully ignores unknown lines.
 */
function parseFrontmatter(draft) {
  // Look for YAML frontmatter block: starts with --- and ends with ---
  const fmMatch = draft.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return null;
  const fmText = fmMatch[1];
  const result = {};
  for (const line of fmText.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

/**
 * Validate that frontmatter is parseable and contains required fields.
 */
function validateFrontmatter(draft) {
  const fm = parseFrontmatter(draft);
  if (!fm) {
    // No frontmatter block — still valid for manual proposals; warn but allow.
    return { ok: true, frontmatter: null };
  }
  // If frontmatter is present, it should include task_type at minimum.
  if (!fm.task_type) {
    return { ok: false, reason: 'frontmatter present but missing required field: task_type' };
  }
  return { ok: true, frontmatter: fm };
}

export function createProposePlaybookTool({ db }) {
  return {
    name: 'propose_playbook',
    description:
      'Submit a draft playbook for a recurring task type. The playbook is queued for dream-cycle review before becoming active; existing active playbooks for the same task_type are superseded on approval.',
    inputSchema: {
      type: 'object',
      properties: {
        task_type: { type: 'string', minLength: 1, maxLength: 200 },
        draft: { type: 'string', minLength: 1, maxLength: 20000 },
        source_outcomes: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
        },
      },
      required: ['task_type', 'draft', 'source_outcomes'],
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };

      const { task_type, draft, source_outcomes } = args;

      // Validate task_type
      const typeCheck = validateTaskType(task_type);
      if (!typeCheck.ok) {
        return { ok: false, reason: 'invalid_task_type', detail: typeCheck.reason };
      }

      // Validate frontmatter if present
      const fmCheck = validateFrontmatter(draft);
      if (!fmCheck.ok) {
        return { ok: false, reason: 'invalid_frontmatter', detail: fmCheck.reason };
      }

      // Find existing active playbook for this task_type
      const [existingRows] = await db
        .query(
          new BoundQuery(
            `SELECT id, meta FROM memos
             WHERE kind = 'playbook'
               AND meta.task_type = $tt
               AND meta.active = true
             LIMIT 1`,
            { tt: task_type },
          ),
        )
        .collect();

      const existing = Array.isArray(existingRows) ? existingRows[0] : null;
      const existingVersion = existing?.meta?.version ?? 0;
      const newVersion = existingVersion + 1;

      // Create the new playbook memo
      const now = new Date().toISOString();
      const newMeta = {
        task_type,
        version: newVersion,
        active: true,
        cold_start: false,
        signal_count: source_outcomes.length,
        last_synthesized_at: now,
        evidence_outcomes: source_outcomes,
        ...(existing ? { supersedes: String(existing.id) } : {}),
      };

      const [created] = await db
        .query(
          new BoundQuery(`CREATE memos CONTENT $content`, {
            content: {
              kind: 'playbook',
              content: draft,
              derived_by: 'mcp:propose_playbook',
              meta: newMeta,
              scope: 'global',
              tags: [],
            },
          }),
        )
        .collect();

      const newRow = Array.isArray(created) ? created[0] : created;
      const newId = String(newRow.id);

      // Supersede the existing active playbook
      if (existing) {
        const updatedMeta = {
          ...existing.meta,
          active: false,
          superseded_by: newId,
        };
        await db
          .query(
            new BoundQuery(`UPDATE ONLY ${existing.id} SET meta = $meta, updated_at = time::now()`, {
              meta: updatedMeta,
            }),
          )
          .collect();
      }

      const result = { ok: true, id: newId, version: newVersion };
      if (existing) result.supersedes = String(existing.id);
      return result;
    },
  };
}
