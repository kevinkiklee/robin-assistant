import { standardLocators } from './generic.ts';
import type { Recipe } from './types.ts';

const shape = /^lin_api_[A-Za-z0-9]{20,}$/;

export const linear: Recipe = {
  provider: 'linear',
  modes: ['create', 'rotate'],
  startUrl: 'https://linear.app/settings/account/security',
  steps: [
    'Open the start URL (it redirects into the workspace settings). If it lands on a sign-in page, stop and ask the operator to sign in (never enter credentials).',
    'Under the personal API keys section, click New API key. Name it with the dashboard key name `robin secret begin` printed. Read the form (permissions/scopes, team access) BEFORE creating and tell the operator exactly what it will grant when asking for OK.',
    'After the OK: `robin secret arm --tab <id>`, click Create, run locateCopy and click its {x,y}, then `robin secret set LINEAR_API_KEY --from-clipboard`. If locateCopy finds nothing, run inspectReveal, then `robin secret set LINEAR_API_KEY --wait` and ask the operator to click Copy.',
    'Close the tab, then `robin secret restart` (Robin reads LINEAR_API_KEY).',
    'Rotation: list the API key NAMES (never values) and ask the operator which old key to revoke, or keep. Revoking needs its own OK.',
  ],
  shape,
  defaultName: 'LINEAR_API_KEY',
  target: { kind: 'robin-env', var: 'LINEAR_API_KEY' },
  rotate: 'create-revoke',
  ...standardLocators(shape),
};
