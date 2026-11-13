import { standardLocators } from './generic.ts';
import type { Recipe } from './types.ts';

const shape = /^sk-ant-api\d\d-[A-Za-z0-9_-]{80,}$/;

export const anthropic: Recipe = {
  provider: 'anthropic',
  modes: ['create', 'rotate'],
  startUrl: 'https://console.anthropic.com/settings/keys',
  steps: ['FILL IN LIVE'],
  shape,
  defaultName: 'CLAUDE_API_KEY',
  target: { kind: 'robin-env', var: 'CLAUDE_API_KEY' },
  rotate: 'create-revoke',
  ...standardLocators(shape),
};
