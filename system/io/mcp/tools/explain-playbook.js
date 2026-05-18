import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

const MAX_LINEAGE_DEPTH = 4;

/**
 * Fetch a memo by ID, returns null if not found. Throws on DB error so the
 * MCP caller distinguishes "no such id" (handler returns
 * {ok:false, reason:'not_found'}) from "DB unreachable / query failed"
 * (propagates as MCP error).
 */
async function fetchMemo(db, id) {
  if (!id) return null;
  const recordRef = String(id).startsWith('memos:') ? String(id) : `memos:${String(id)}`;
  const [rows] = await db.query(`SELECT * FROM ${recordRef}`).collect();
  return (Array.isArray(rows) ? rows[0] : rows) ?? null;
}

/**
 * Walk the superseded_by chain backward one step to find the prior version.
 * A playbook's meta.supersedes points to the version it replaced.
 */
async function fetchPriorVersion(db, playbook) {
  const supersedes = playbook?.meta?.supersedes;
  if (!supersedes) return null;
  return fetchMemo(db, supersedes);
}

/**
 * Fetch source outcome memos (up to depth 4), returning truncated excerpts.
 */
async function fetchSourceOutcomes(db, outcomeIds, depth = 0) {
  if (!outcomeIds || outcomeIds.length === 0 || depth >= MAX_LINEAGE_DEPTH) {
    return { outcomes: [], truncated: depth >= MAX_LINEAGE_DEPTH && outcomeIds?.length > 0 };
  }

  const ids = outcomeIds.slice(0, MAX_LINEAGE_DEPTH);
  const truncated = outcomeIds.length > MAX_LINEAGE_DEPTH;

  const results = [];
  for (const oid of ids) {
    const row = await fetchMemo(db, oid);
    if (row) {
      results.push({
        id: String(row.id),
        kind: row.kind,
        content_excerpt: (row.content ?? '').slice(0, 200),
        meta: {
          task_type: row.meta?.task_type ?? null,
          task_id: row.meta?.task_id ?? null,
          score: row.meta?.score ?? null,
          signals: row.meta?.signals ?? {},
        },
        derived_at: row.derived_at ?? null,
      });
    }
  }

  return { outcomes: results, truncated };
}

/**
 * Fetch cited rules with current active status.
 */
async function fetchCitedRules(db, ruleIds) {
  if (!ruleIds || ruleIds.length === 0) return [];

  const results = [];
  for (const rid of ruleIds.slice(0, 20)) {
    const ref = String(rid).startsWith('rules:') ? String(rid) : `rules:${String(rid)}`;
    try {
      const [rows] = await db
        .query(`SELECT id, content, active, kind, priority FROM ${ref}`)
        .collect();
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) {
        results.push({
          id: String(row.id),
          content: (row.content ?? '').slice(0, 300),
          active: row.active ?? null,
          kind: row.kind ?? null,
          priority: row.priority ?? null,
        });
      }
    } catch {
      // Rule may have been deleted — skip.
    }
  }
  return results;
}

export function createExplainPlaybookTool({ db }) {
  return {
    name: 'explain_playbook',
    description:
      'Explain why a playbook was synthesized: shows the source task_outcome memos, which dream step produced it, and how the step-by-step content was derived from observed signals.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };

      const { id } = args;
      const playbook = await fetchMemo(db, id);
      if (!playbook || playbook.kind !== 'playbook') {
        return { ok: false, reason: 'not_found' };
      }

      // Frontmatter + body
      const meta = playbook.meta ?? {};

      // Prior version (one step back via supersedes chain)
      const priorVersion = await fetchPriorVersion(db, playbook);

      // Source outcomes with truncated excerpts
      const outcomeIds = meta.evidence_outcomes ?? [];
      const { outcomes, truncated: outcomesTruncated } = await fetchSourceOutcomes(
        db,
        outcomeIds,
        0,
      );

      // Cited rules with current active status
      const ruleIds = meta.related_rules ?? [];
      const citedRules = await fetchCitedRules(db, ruleIds);

      return {
        ok: true,
        playbook: {
          id: String(playbook.id),
          kind: playbook.kind,
          content: playbook.content,
          derived_by: playbook.derived_by,
          derived_at: playbook.derived_at,
          meta: {
            task_type: meta.task_type ?? null,
            version: meta.version ?? null,
            active: meta.active ?? null,
            cold_start: meta.cold_start ?? null,
            signal_count: meta.signal_count ?? null,
            last_synthesized_at: meta.last_synthesized_at ?? null,
            synthesis_step_version: meta.synthesis_step_version ?? null,
            supersedes: meta.supersedes ?? null,
            superseded_by: meta.superseded_by ?? null,
          },
        },
        prior_version: priorVersion
          ? {
              id: String(priorVersion.id),
              version: priorVersion.meta?.version ?? null,
              derived_at: priorVersion.derived_at ?? null,
              active: priorVersion.meta?.active ?? null,
              content_excerpt: (priorVersion.content ?? '').slice(0, 500),
            }
          : null,
        source_outcomes: {
          items: outcomes,
          truncated: outcomesTruncated,
          total: outcomeIds.length,
        },
        cited_rules: citedRules,
        comm_style_snapshot_id: meta.related_comm_style_snapshot ?? null,
      };
    },
  };
}
