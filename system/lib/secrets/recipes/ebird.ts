import { standardLocators } from './generic.ts';
import type { Recipe } from './types.ts';

const shape = /^[A-Za-z0-9]{10,}$/;

export const ebird: Recipe = {
  provider: 'ebird',
  modes: ['get'],
  startUrl: 'https://ebird.org/api/keygen',
  steps: ['FILL IN LIVE'],
  shape,
  defaultName: 'EBIRD_API_KEY',
  target: { kind: 'robin-env', var: 'EBIRD_API_KEY' },
  rotate: 'create-revoke',
  ...standardLocators(shape),
};
