import { standardLocators } from './generic.ts';
import type { Recipe } from './types.ts';

const shape = /^[A-Za-z0-9_-]{40}$/;

export const cloudflare: Recipe = {
  provider: 'cloudflare',
  modes: ['create', 'rotate'],
  startUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  steps: ['FILL IN LIVE'],
  shape,
  defaultName: 'CLOUDFLARE_API_TOKEN',
  target: { kind: 'secret-file', path: '~/.cloudflare/token' },
  rotate: 'roll',
  ...standardLocators(shape),
};
