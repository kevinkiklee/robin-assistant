import { standardLocators } from './generic.ts';
import type { Recipe } from './types.ts';

const shape = /^lin_api_[A-Za-z0-9]{20,}$/;

export const linear: Recipe = {
  provider: 'linear',
  modes: ['create', 'rotate'],
  startUrl: 'https://linear.app/settings/account/security',
  steps: ['FILL IN LIVE'],
  shape,
  defaultName: 'LINEAR_API_KEY',
  target: { kind: 'robin-env', var: 'LINEAR_API_KEY' },
  rotate: 'create-revoke',
  ...standardLocators(shape),
};
