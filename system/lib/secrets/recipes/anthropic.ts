import { standardLocators } from './generic.ts';
import type { Recipe } from './types.ts';

const shape = /^sk-ant-api\d\d-[A-Za-z0-9_-]{80,}$/;

export const anthropic: Recipe = {
  provider: 'anthropic',
  modes: ['create', 'rotate'],
  // console.anthropic.com/settings/keys redirects here (verified 2026-11-13).
  startUrl: 'https://platform.claude.com/settings/keys',
  steps: [
    'Open the start URL. If it shows a sign-in page (Continue with Google / email / SSO), stop and ask the operator to sign in (never enter credentials).',
    "A new key costs money when used: before anything else, tell the operator the key goes to CLAUDE_API_KEY (Robin's dispatcher key — never ANTHROPIC_API_KEY or CLAUDE_CREDIT_KEY_*, which `robin secret` refuses).",
    'Click Create Key. Name it with the dashboard key name `robin secret begin` printed. Read the form (workspace, any other fields) BEFORE creating and tell the operator exactly what the key will be tied to when asking for OK.',
    "After the OK: `robin secret arm --tab <id>`, click the form's create/confirm button, run locateCopy and click its {x,y}, then `robin secret set CLAUDE_API_KEY --from-clipboard`. If locateCopy finds nothing, run inspectReveal, then `robin secret set CLAUDE_API_KEY --wait` and ask the operator to click Copy (the key is shown once).",
    'Close the tab, then `robin secret restart`.',
    'Rotation: list the key NAMES shown on the page (never values or hints) and ask the operator which old key to disable or delete, or keep. That needs its own OK.',
  ],
  shape,
  defaultName: 'CLAUDE_API_KEY',
  target: { kind: 'robin-env', var: 'CLAUDE_API_KEY' },
  rotate: 'create-revoke',
  ...standardLocators(shape),
};
