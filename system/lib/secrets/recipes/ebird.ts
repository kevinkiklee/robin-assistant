import { standardLocators } from './generic.ts';
import type { Recipe } from './types.ts';

// eBird keys: 12 lowercase letters and digits, at least one of each (so plain words never match).
const shape = /^(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{12}$/;

export const ebird: Recipe = {
  provider: 'ebird',
  modes: ['get'],
  startUrl: 'https://ebird.org/api/keygen',
  steps: [
    'The key page shows the key as soon as it loads, so the window opens first: tabs_create, then `robin secret arm --tab <id>`, then navigate the tab to the start URL. If it lands on a Cornell/eBird sign-in page instead, close the tab and ask the operator to sign in (never enter credentials).',
    'Run locateCopy and click its {x,y} if found, then `robin secret set EBIRD_API_KEY --from-clipboard`.',
    'If locateCopy finds nothing (the page may have no Copy button), run inspectReveal to learn the layout, then `robin secret set EBIRD_API_KEY --wait` and ask the operator to select the key and press Cmd-C.',
    'Close the tab. An unchanged key reports "already current".',
  ],
  shape,
  defaultName: 'EBIRD_API_KEY',
  target: { kind: 'robin-env', var: 'EBIRD_API_KEY' },
  rotate: 'create-revoke',
  ...standardLocators(shape),
};
