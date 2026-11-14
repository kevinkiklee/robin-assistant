import { standardLocators } from './generic.ts';
import type { Recipe } from './types.ts';

// Classic tokens are 40 chars; newer ones carry a short lowercase prefix and run longer.
const shape = /^[A-Za-z0-9_-]{40,64}$/;

export const cloudflare: Recipe = {
  provider: 'cloudflare',
  modes: ['create', 'rotate'],
  startUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  steps: [
    'Open the start URL. If it redirects to /login, stop and ask the operator to sign in (never enter credentials).',
    'Find the target token by ID, not name (several tokens can share a name): get the current token ID with `curl -s -H "Authorization: Bearer $(tr -d \'\\n\' < ~/.cloudflare/token)" https://api.cloudflare.com/client/v4/user/tokens/verify` (print only result.id), then in the page run a fetch of /api/v4/user/tokens and return only the name and permissions of the entry with that id.',
    'Rotate = Roll (same token id and permissions; the old value dies at once). Open that row\'s Actions menu → Roll. The confirm dialog ("Are you sure you want to roll the token …?") shows no token yet: record the Roll button\'s centre coordinates now.',
    'Ask the operator for OK to roll, naming the token. Then `robin secret arm --tab <id>`, click Roll at the recorded coordinates, run locateCopy and click it, then `robin secret set CLOUDFLARE_API_TOKEN --from-clipboard`. If locateCopy finds nothing, run `robin secret set CLOUDFLARE_API_TOKEN --wait` and ask the operator to click Copy.',
    'Close the tab. New shells pick the token up from ~/.cloudflare/token; already-open shells keep the dead value until restarted.',
  ],
  shape,
  defaultName: 'CLOUDFLARE_API_TOKEN',
  target: { kind: 'secret-file', path: '~/.cloudflare/token' },
  rotate: 'roll',
  ...standardLocators(shape),
};
