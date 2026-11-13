import type { Recipe } from './types.ts';

export type GoogleIntegration = 'gmail' | 'google_calendar';

/** Integration chosen by NAME prefix; undefined when the name matches neither. */
export function googleIntegrationFor(name: string): GoogleIntegration | undefined {
  if (name.startsWith('GMAIL_')) return 'gmail';
  if (name.startsWith('GOOGLE_CALENDAR_')) return 'google_calendar';
  return undefined;
}

export const google: Recipe = {
  provider: 'google',
  modes: ['rotate'],
  startUrl: 'https://accounts.google.com/',
  steps: [
    "run: robin reauth <integration>, then click through the consent screen after the operator's OK. No window is armed; the token never renders.",
  ],
  shape: /^\S{16,}$/,
  defaultName: 'GMAIL_REFRESH_TOKEN',
  target: { kind: 'robin-env', var: 'GMAIL_REFRESH_TOKEN' },
  rotate: 'oauth',
  oauthIntegration: 'gmail',
};
