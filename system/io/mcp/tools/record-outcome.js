import { BoundQuery } from 'surrealdb';
import { validateTaskType } from '../../../cognition/introspection/task-taxonomy.js';
import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

// Signal priority order: explicit_correction > outcome_inference > self_grade
const SIGNAL_PRIORITY = ['explicit_correction', 'outcome_inference', 'self_grade'];

/**
 * Merge two signal objects by priority.
 * Higher-priority signals win on conflict; unprioritized keys are kept from either.
 */
function mergeSignals(existing, incoming) {
  const merged = { ...existing };
  for (const [key, val] of Object.entries(incoming)) {
    const existingIdx = SIGNAL_PRIORITY.indexOf(key);
    const prevVal = merged[key];
    if (prevVal === undefined) {
      merged[key] = val;
    } else {
      // For non-priority keys, incoming wins (overwrite).
      // For priority keys, lower index = higher priority → keep existing if it was
      // present with a higher-priority source; otherwise overwrite.
      if (existingIdx === -1) {
        // Not a priority key; incoming overwrites.
        merged[key] = val;
      }
      // Priority key already exists — keep existing (higher priority wins).
    }
  }
  return merged;
}

/**
 * Merge score: take the minimum (most severe), unless incoming has higher
 * priority signal (explicit_correction always yields score=0).
 */
function mergeScore(existingScore, incomingScore, existingSignals, incomingSignals) {
  // If incoming has explicit_correction, that's authoritative (score=0).
  if (incomingSignals?.explicit_correction !== undefined) {
    return 0;
  }
  if (existingScore === null && incomingScore === null) return null;
  if (existingScore === null) return incomingScore;
  if (incomingScore === null) return existingScore;
  return Math.min(existingScore, incomingScore);
}

export function createRecordOutcomeTool({ db }) {
  return {
    name: 'record_outcome',
    description:
      'Record the outcome of a completed task so Robin can learn from it over time. Signals (quality, latency, user corrections) feed the introspection faculty and are synthesized into playbooks during the nightly dream cycle.',
    inputSchema: {
      type: 'object',
      properties: {
        task_type: { type: 'string', minLength: 1, maxLength: 200 },
        task_id: { type: 'string', minLength: 1, maxLength: 200 },
        signals: { type: 'object' },
        source_event: { type: 'string' },
      },
      required: ['task_type', 'task_id', 'signals'],
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };

      const { task_type, task_id, signals, source_event } = args;

      // Validate task_type
      const typeCheck = validateTaskType(task_type);
      if (!typeCheck.ok) {
        return { ok: false, reason: 'invalid_task_type', detail: typeCheck.reason };
      }

      // Look for existing task_outcome memo with same (task_type, task_id)
      const [existingRows] = await db
        .query(
          new BoundQuery(
            `SELECT id, meta FROM memos
             WHERE kind = 'task_outcome'
               AND meta.task_type = $tt
               AND meta.task_id = $tid
             LIMIT 1`,
            { tt: task_type, tid: task_id },
          ),
        )
        .collect();

      const existing = Array.isArray(existingRows) ? existingRows[0] : null;

      if (existing) {
        // Merge signals per priority
        const prevSignals = existing.meta?.signals ?? {};
        const prevScore = existing.meta?.score ?? null;
        const mergedSignals = mergeSignals(prevSignals, signals);
        const mergedScore = mergeScore(prevScore, signals?.score ?? null, prevSignals, signals);

        const updatedMeta = {
          ...existing.meta,
          signals: mergedSignals,
          score: mergedScore,
        };
        if (source_event && !updatedMeta.source_event) {
          updatedMeta.source_event = source_event;
        }

        await db
          .query(
            new BoundQuery(
              `UPDATE ONLY ${existing.id} SET meta = $meta, updated_at = time::now()`,
              { meta: updatedMeta },
            ),
          )
          .collect();

        return { ok: true, id: String(existing.id), action: 'updated' };
      }

      // Create new task_outcome memo
      const incomingScore = signals?.score ?? null;
      const scoreForMemo = signals?.explicit_correction !== undefined ? 0 : incomingScore;

      const content = `task_outcome ${task_type}/${task_id}: ${Object.keys(signals).join(', ')}${scoreForMemo !== null ? ` (score=${scoreForMemo})` : ''}`;
      const meta = {
        task_type,
        task_id,
        source_event: source_event ?? null,
        signals,
        score: scoreForMemo,
      };

      const [created] = await db
        .query(
          new BoundQuery(`CREATE memos CONTENT $content`, {
            content: {
              kind: 'task_outcome',
              content,
              derived_by: 'mcp:record_outcome',
              meta,
              scope: 'global',
              tags: [],
            },
          }),
        )
        .collect();

      const row = Array.isArray(created) ? created[0] : created;
      return { ok: true, id: String(row.id), action: 'created' };
    },
  };
}
