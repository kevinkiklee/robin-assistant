import { anthropic } from './anthropic.ts';
import { cloudflare } from './cloudflare.ts';
import { ebird } from './ebird.ts';
import { google } from './google.ts';
import { linear } from './linear.ts';
import type { Recipe } from './types.ts';

export { buildLocateScript, scriptHashes } from './generic.ts';
export type { Recipe } from './types.ts';

const ALL: Recipe[] = [cloudflare, linear, anthropic, ebird, google];
const PLACEHOLDER = 'FILL IN';

const ready = (r: Recipe): boolean => !r.steps.some((s) => s.includes(PLACEHOLDER));

export function getRecipe(provider: string): Recipe | undefined {
  return listRecipes().find((r) => r.provider === provider);
}

export function listRecipes(): Recipe[] {
  return ALL.filter(ready);
}
