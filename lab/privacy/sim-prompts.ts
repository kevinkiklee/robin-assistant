import {
  getDefaultPrompt,
  PROMPT_KEYS,
  type PromptKey,
} from '../../system/brain/cognition/prompts.ts';

export const SIM_USER_CONTEXT =
  'Context: The user is Sim User, a hobby cyclist who plans rides, keeps a few routines and has everyday preferences.';

// The code defaults are generic already; the sim user is simply unnamed.
const REPLACEMENTS: [RegExp, string][] = [[/\{\{USER_NAME\}\}/g, 'the user']];

/** Production prompts with personal details swapped for the sim user. */
export function simPrompts(): Record<PromptKey, string> {
  const out = {} as Record<PromptKey, string>;
  for (const k of PROMPT_KEYS) {
    let text = getDefaultPrompt(k);
    for (const [re, to] of REPLACEMENTS) text = text.replace(re, to);
    out[k] = text;
  }
  out['biographer.userContext'] = SIM_USER_CONTEXT;
  return out;
}
