// lab/llm/lab-dispatcher.ts
import { buildDispatcherFromConfig } from '../../system/brain/llm/build-dispatcher.ts';
import { LLMDispatcher } from '../../system/brain/llm/dispatcher.ts';
import type { LLMRole } from '../../system/brain/llm/types.ts';
import type { ModelsConfig } from '../../system/kernel/config/schema.ts';
import { assertLabModels } from '../sandbox/guards.ts';
import { createTemplateProvider, type TemplateProvider } from './template-provider.ts';

export type LabModels = { mode: 'template' } | { mode: 'config'; models: ModelsConfig };

const TEMPLATE_ROLES: LLMRole[] = [
  'reasoning',
  'summarize',
  'classify',
  'embed',
  'rerank',
  'interactive',
];

export function buildLabDispatcher(m: LabModels): {
  llm: LLMDispatcher;
  template: TemplateProvider | null;
} {
  if (m.mode === 'config') {
    // Refuse forbidden providers (claude-agent) BEFORE any provider is built.
    assertLabModels(m.models);
    return { llm: buildDispatcherFromConfig(m.models, { env: process.env }), template: null };
  }
  const template = createTemplateProvider();
  const llm = new LLMDispatcher();
  llm.register('lab-template', template);
  for (const role of TEMPLATE_ROLES) llm.assign(role, 'lab-template');
  return { llm, template };
}
