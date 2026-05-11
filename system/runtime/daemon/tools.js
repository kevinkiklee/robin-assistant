import { dreamProcess } from '../../cognition/dream/pipeline.js';
import { runIntegrationSync } from '../../io/integrations/_framework/run-sync.js';
import { createArchiveHistoryTool } from '../../io/mcp/tools/archive-history.js';
import { createAuditTool } from '../../io/mcp/tools/audit.js';
import { createCheckActionTool } from '../../io/mcp/tools/check-action.js';
import { createEndorseTool } from '../../io/mcp/tools/endorse.js';
import { createExplainActionTrustTool } from '../../io/mcp/tools/explain-action-trust.js';
import { createExplainBeliefTool } from '../../io/mcp/tools/explain-belief.js';
import { createExplainRecallTool } from '../../io/mcp/tools/explain-recall.js';
import { createFindEntityTool } from '../../io/mcp/tools/find-entity.js';
import { createGetArcTool } from '../../io/mcp/tools/get-arc.js';
import { createGetCommStyleTool } from '../../io/mcp/tools/get-comm-style.js';
import { createGetEntityTool } from '../../io/mcp/tools/get-entity.js';
import { createGetHotTool } from '../../io/mcp/tools/get-hot.js';
import { createGetKnowledgeTool } from '../../io/mcp/tools/get-knowledge.js';
import { createGetProfileTool } from '../../io/mcp/tools/get-profile.js';
import { createHealthTool } from '../../io/mcp/tools/health.js';
import { createIngestTool } from '../../io/mcp/tools/ingest.js';
import { createIntegrationRunTool } from '../../io/mcp/tools/integration-run.js';
import { createIntegrationStatusTool } from '../../io/mcp/tools/integration-status.js';
import { createLintTool } from '../../io/mcp/tools/lint.js';
import { createListArcsTool } from '../../io/mcp/tools/list-arcs.js';
import { createListEpisodesTool } from '../../io/mcp/tools/list-episodes.js';
import { createListJobsTool } from '../../io/mcp/tools/list-jobs.js';
import { createListJournalTool } from '../../io/mcp/tools/list-journal.js';
import { createListOpenPredictionsTool } from '../../io/mcp/tools/list-open-predictions.js';
import { createListPatternsTool } from '../../io/mcp/tools/list-patterns.js';
import { createListRulesTool } from '../../io/mcp/tools/list-rules.js';
import { createPredictTool } from '../../io/mcp/tools/predict.js';
import { createRecallTool } from '../../io/mcp/tools/recall.js';
import { createRecentRefusalsTool } from '../../io/mcp/tools/recent-refusals.js';
import { createRecordCorrectionTool } from '../../io/mcp/tools/record-correction.js';
import { createRefuteTool } from '../../io/mcp/tools/refute.js';
import { createRelatedEntitiesTool } from '../../io/mcp/tools/related-entities.js';
import { createRememberTool } from '../../io/mcp/tools/remember.js';
import { createResolvePredictionTool } from '../../io/mcp/tools/resolve-prediction.js';
import { createRunBiographerTool } from '../../io/mcp/tools/run-biographer.js';
import { createRunDreamTool } from '../../io/mcp/tools/run-dream.js';
import { createRunJobTool } from '../../io/mcp/tools/run-job.js';
import { createShowPendingTriggersTool } from '../../io/mcp/tools/show-pending-triggers.js';
import { createShowStepHealthTool } from '../../io/mcp/tools/show-step-health.js';
import { createShowTelemetryRollupTool } from '../../io/mcp/tools/show-telemetry-rollup.js';
import { createUpdateActionPolicyTool } from '../../io/mcp/tools/update-action-policy.js';
import { createUpdateRuleTool } from '../../io/mcp/tools/update-rule.js';

/**
 * Build the MCP tool array from a ctx. Pure: no side effects, no module
 * state. Safe to call from tests against a stub ctx.
 *
 * The createRunJobTool `tools: () => tools` thunk is preserved — it
 * dispatches other tools by name during job execution.
 */
export function buildTools(ctx) {
  const tools = [];
  const getTools = () => tools;
  const dbWrap = { isOpen: () => true, query: (...a) => ctx.db.query(...a) };

  tools.push(
    createHealthTool({
      version: ctx.version,
      startedAt: ctx.startedAt,
      db: dbWrap,
      embedder: ctx.embedder.wrap,
      biographerQueue: ctx.queue,
      sessions: ctx.sessions,
    }),
    createRecallTool({
      db: ctx.db,
      embedder: ctx.embedder.wrap,
      detector: ctx.detector,
      // B1.0: read from the live sessions context. When future work populates
      // sessions.active during a hook-bound MCP call, recall_log rows from
      // MCP recall pick up the session_id. Until then this remains null —
      // identical to the prior stub — but the wiring is in place.
      getSessionId: () => ctx.sessions?.active?.session_id ?? null,
    }),
    createRememberTool({ db: ctx.db, embedder: ctx.embedder.wrap, queue: ctx.queue }),
    createRunBiographerTool({ db: ctx.db, processor: ctx.queue.enqueue }),
    createFindEntityTool({ db: ctx.db, embedder: ctx.embedder.wrap }),
    createGetEntityTool({ db: ctx.db }),
    createRelatedEntitiesTool({ db: ctx.db }),
    createListEpisodesTool({ db: ctx.db }),
    createRecordCorrectionTool({
      db: ctx.db,
      embedder: ctx.embedder.wrap,
      processor: ctx.queue.enqueue,
    }),
    createGetKnowledgeTool({ db: ctx.db, embedder: ctx.embedder.wrap }),
    createListPatternsTool({ db: ctx.db }),
    createGetProfileTool({ db: ctx.db }),
    createListJournalTool({ db: ctx.db }),
    createGetHotTool({ db: ctx.db }),
    createListRulesTool({ db: ctx.db }),
    createUpdateRuleTool({ db: ctx.db }),
    createRunDreamTool({
      db: ctx.db,
      host: ctx.host,
      embedder: ctx.embedder.wrap,
      dreamProcess,
    }),
    createIntegrationStatusTool({ db: ctx.db }),
    createIntegrationRunTool({ db: ctx.db, registry: ctx.registry, runIntegrationSync }),
  );

  // Per-manifest integration tools
  const getGatewayClient = (name) => ctx.gatewayClients.get(name) ?? null;
  for (const m of ctx.manifests) {
    for (const factory of m.tools ?? []) {
      try {
        const reg = ctx.registry.get(m.name);
        tools.push(
          factory({
            db: ctx.db,
            embedder: ctx.embedder.wrap,
            capture: reg?.capture,
            getGatewayClient,
          }),
        );
      } catch (e) {
        console.warn(`integration ${m.name}: tool factory failed: ${e.message}`);
      }
    }
  }

  tools.push(
    createListJobsTool({ db: ctx.db }),
    createRunJobTool({
      db: ctx.db,
      capture: ctx.capture.forJobs,
      host: ctx.host,
      tools: getTools,
      getJobs: () => ctx.jobs.cache.current,
    }),
    createIngestTool({ db: ctx.db, embedder: ctx.embedder.wrap, host: ctx.host }),
    createLintTool({ db: ctx.db }),
    createAuditTool({ db: ctx.db, host: ctx.host }),
    createCheckActionTool({ db: ctx.db }),
    createUpdateActionPolicyTool({ db: ctx.db }),
    createGetCommStyleTool({ db: ctx.db }),
    createPredictTool({ db: ctx.db }),
    createResolvePredictionTool({ db: ctx.db }),
    createListOpenPredictionsTool({ db: ctx.db }),
    createEndorseTool({ db: ctx.db }),
    createRefuteTool({ db: ctx.db }),
    createListArcsTool({ db: ctx.db }),
    createGetArcTool({ db: ctx.db }),
    createExplainRecallTool({ db: ctx.db }),
    createExplainBeliefTool({ db: ctx.db }),
    createExplainActionTrustTool({ db: ctx.db }),
    createShowPendingTriggersTool({ db: ctx.db }),
    createShowStepHealthTool({ db: ctx.db }),
    createShowTelemetryRollupTool({ db: ctx.db }),
    createRecentRefusalsTool({ db: ctx.db }),
    createArchiveHistoryTool({ db: ctx.db }),
  );

  return tools;
}
