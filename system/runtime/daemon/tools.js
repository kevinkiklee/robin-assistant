import { dreamProcess } from '../../cognition/dream/pipeline.js';
import { isEnabled, readIntegrationsState } from '../../data/runtime/integrations-state.js';
import { runIntegrationSync } from '../../io/integrations/_framework/run-sync.js';
import { createArchiveHistoryTool } from '../../io/mcp/tools/archive-history.js';
import { createAuditTool } from '../../io/mcp/tools/audit.js';
import {
  createBrowserExtractTool,
  createBrowserScreenshotTool,
  createBrowserVisitTool,
} from '../../io/mcp/tools/browser.js';
import { createCheckActionTool } from '../../io/mcp/tools/check-action.js';
import { createExplainActionTrustTool } from '../../io/mcp/tools/explain-action-trust.js';
import { createExplainLearningTool } from '../../io/mcp/tools/explain-learning.js';
import { createExplainPlaybookTool } from '../../io/mcp/tools/explain-playbook.js';
import { createExplainRecallTool } from '../../io/mcp/tools/explain-recall.js';
import { createFindEntityTool } from '../../io/mcp/tools/find-entity.js';
import { createGetArcTool } from '../../io/mcp/tools/get-arc.js';
import { createGetCalibrationTool } from '../../io/mcp/tools/get-calibration.js';
import { createGetCommStyleTool } from '../../io/mcp/tools/get-comm-style.js';
import { createGetEntityTool } from '../../io/mcp/tools/get-entity.js';
import { createGetHotTool } from '../../io/mcp/tools/get-hot.js';
import { createGetKnowledgeTool } from '../../io/mcp/tools/get-knowledge.js';
import { createGetPlaybookTool } from '../../io/mcp/tools/get-playbook.js';
import { createGetProfileTool } from '../../io/mcp/tools/get-profile.js';
import { createHealthTool } from '../../io/mcp/tools/health.js';
import { createImessageSendTool } from '../../io/mcp/tools/imessage-send.js';
import { createIngestTool } from '../../io/mcp/tools/ingest.js';
import { createIntegrationRunTool } from '../../io/mcp/tools/integration-run.js';
import { createIntegrationStatusTool } from '../../io/mcp/tools/integration-status.js';
import { createLintTool } from '../../io/mcp/tools/lint.js';
import { createListArcsTool } from '../../io/mcp/tools/list-arcs.js';
import { createListCommStyleSnapshotsTool } from '../../io/mcp/tools/list-comm-style-snapshots.js';
import { createListEpisodesTool } from '../../io/mcp/tools/list-episodes.js';
import { createListJobsTool } from '../../io/mcp/tools/list-jobs.js';
import { createListJournalTool } from '../../io/mcp/tools/list-journal.js';
import { createListOpenPredictionsTool } from '../../io/mcp/tools/list-open-predictions.js';
import { createListPatternsTool } from '../../io/mcp/tools/list-patterns.js';
import { createListPlaybooksTool } from '../../io/mcp/tools/list-playbooks.js';
import { createListRulesTool } from '../../io/mcp/tools/list-rules.js';
import { createMacosNotifyTool } from '../../io/mcp/tools/macos-notify.js';
import { createPredictTool } from '../../io/mcp/tools/predict.js';
import { createProposePlaybookTool } from '../../io/mcp/tools/propose-playbook.js';
import { createRecallTool } from '../../io/mcp/tools/recall.js';
import { createRecentRefusalsTool } from '../../io/mcp/tools/recent-refusals.js';
import { createRecordCorrectionTool } from '../../io/mcp/tools/record-correction.js';
import { createRecordOutcomeTool } from '../../io/mcp/tools/record-outcome.js';
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
import { getSessionId } from '../mcp/current-call.js';

/**
 * Build the MCP tool array from a ctx. Pure: no side effects, no module
 * state. Safe to call from tests against a stub ctx.
 *
 * The createRunJobTool `tools: () => tools` thunk is preserved — it
 * dispatches other tools by name during job execution.
 */
export async function buildTools(ctx) {
  const tools = [];
  const getTools = () => tools;
  const dbWrap = { isOpen: () => true, query: (...a) => ctx.db.query(...a) };
  const intState = await readIntegrationsState(ctx.db);

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
      // ALS-backed: returns transport.sessionId for the current MCP call.
      getSessionId,
      getMostRecentSessionId: async () => {
        const live = getSessionId();
        if (live) return live;
        try {
          const [rows] = await ctx.db
            .query(
              "SELECT session_id FROM runtime_sessions WHERE status = 'active' ORDER BY last_seen_at DESC LIMIT 1",
            )
            .collect();
          return rows?.[0]?.session_id ?? null;
        } catch {
          return null;
        }
      },
    }),
    createRememberTool({ db: ctx.db, embedder: ctx.embedder.wrap, queue: ctx.queue, getSessionId }),
    createRunBiographerTool({ db: ctx.db, processor: ctx.queue.enqueue }),
    createFindEntityTool({ db: ctx.db, embedder: ctx.embedder.wrap, getSessionId }),
    createGetEntityTool({ db: ctx.db, getSessionId }),
    createRelatedEntitiesTool({ db: ctx.db, getSessionId }),
    createListEpisodesTool({ db: ctx.db, getSessionId }),
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
    createMacosNotifyTool(),
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
    if (!isEnabled(intState, m.name)) continue;
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
      embedder: ctx.embedder.wrap,
      tools: getTools,
      getJobs: () => ctx.jobs.cache.current,
    }),
    createIngestTool({ db: ctx.db, embedder: ctx.embedder.wrap, host: ctx.host, getSessionId }),
    createImessageSendTool(),
    createBrowserVisitTool(),
    createBrowserScreenshotTool(),
    createBrowserExtractTool(),
    createLintTool({ db: ctx.db }),
    createAuditTool({ db: ctx.db, host: ctx.host }),
    createCheckActionTool({ db: ctx.db }),
    createUpdateActionPolicyTool({ db: ctx.db }),
    createGetCommStyleTool({ db: ctx.db }),
    createPredictTool({ db: ctx.db, embedder: ctx.embedder.wrap }),
    createResolvePredictionTool({ db: ctx.db }),
    createListOpenPredictionsTool({ db: ctx.db }),
    createListArcsTool({ db: ctx.db }),
    createGetArcTool({ db: ctx.db }),
    createExplainRecallTool({ db: ctx.db }),
    createExplainActionTrustTool({ db: ctx.db }),
    createShowPendingTriggersTool({ db: ctx.db }),
    createShowStepHealthTool({ db: ctx.db }),
    createShowTelemetryRollupTool({ db: ctx.db }),
    createRecentRefusalsTool({ db: ctx.db, getSessionId }),
    createArchiveHistoryTool({ db: ctx.db, getSessionId }),
    createRecordOutcomeTool({ db: ctx.db }),
    createProposePlaybookTool({ db: ctx.db }),
    createListPlaybooksTool({ db: ctx.db }),
    createGetPlaybookTool({ db: ctx.db }),
    createExplainPlaybookTool({ db: ctx.db }),
    createListCommStyleSnapshotsTool({ db: ctx.db }),
    createGetCalibrationTool({ db: ctx.db }),
    createExplainLearningTool({ db: ctx.db }),
  );

  return tools;
}
