import { actionsRoutes } from './actions.js';
import { biographerRoutes } from './biographer.js';
import { calibrationRoutes } from './calibration.js';
import { commstyleRoutes } from './commstyle.js';
import { embeddingsRoutes } from './embeddings.js';
import { intuitionRoutes } from './intuition.js';
import { jobsRoutes } from './jobs.js';
import { knowledgeRoutes } from './knowledge.js';
import { predictionsRoutes } from './predictions.js';
import { rememberRoutes } from './remember.js';
import { sessionRoutes } from './session.js';

export function buildRoutes() {
  return [
    ...actionsRoutes,
    ...biographerRoutes,
    ...calibrationRoutes,
    ...commstyleRoutes,
    ...embeddingsRoutes,
    ...intuitionRoutes,
    ...jobsRoutes,
    ...knowledgeRoutes,
    ...predictionsRoutes,
    ...rememberRoutes,
    ...sessionRoutes,
  ];
}
