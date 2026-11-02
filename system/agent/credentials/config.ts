import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

export type CredentialName = 'robin' | 'shared';

export interface Credential {
  /** e.g. 'robin:subscription' */
  id: string;
  name: CredentialName;
  kind: 'subscription' | 'credit';
  fingerprint: string;
  /** The secret lives only inside `env.set`. */
  env: { set: Record<string, string>; unset: string[] };
}

/** First 12 hex chars of sha256 — identifies a credential without revealing it. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

const SOURCES: Array<{
  name: CredentialName;
  kind: Credential['kind'];
  envVar: string;
  target: string;
  unset: string[];
}> = [
  {
    name: 'robin',
    kind: 'subscription',
    envVar: 'CLAUDE_TOKEN_ROBIN',
    target: 'CLAUDE_CODE_OAUTH_TOKEN',
    unset: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  },
  {
    name: 'shared',
    kind: 'subscription',
    envVar: 'CLAUDE_TOKEN_SHARED',
    target: 'CLAUDE_CODE_OAUTH_TOKEN',
    unset: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  },
  {
    name: 'robin',
    kind: 'credit',
    envVar: 'CLAUDE_CREDIT_KEY_ROBIN',
    target: 'ANTHROPIC_API_KEY',
    unset: ['CLAUDE_CODE_OAUTH_TOKEN'],
  },
  {
    name: 'shared',
    kind: 'credit',
    envVar: 'CLAUDE_CREDIT_KEY_SHARED',
    target: 'ANTHROPIC_API_KEY',
    unset: ['CLAUDE_CODE_OAUTH_TOKEN'],
  },
];

/**
 * Every env var a credential is read from. runSdk strips all of them from the
 * SDK child's env, so a child only ever holds the one credential chosen for it.
 */
export const CREDENTIAL_SOURCE_VARS: readonly string[] = SOURCES.map((s) => s.envVar);

/** Configured credentials in priority order; blank values are ignored. */
export function loadCredentials(env: Record<string, string | undefined>): Credential[] {
  const out: Credential[] = [];
  for (const s of SOURCES) {
    const secret = env[s.envVar]?.trim();
    if (!secret) continue;
    out.push(
      makeCredential(
        { id: `${s.name}:${s.kind}`, name: s.name, kind: s.kind, fingerprint: fingerprint(secret) },
        { set: { [s.target]: secret }, unset: [...s.unset] },
      ),
    );
  }
  return out;
}

/**
 * `env` is non-enumerable and both objects carry a redacting `toJSON` (and
 * `env` a redacting `inspect.custom`), so `JSON.stringify`, `{...spread}` and
 * `util.inspect` of a credential, of its `env`, or of a call input holding that
 * `env` never carry the secret. Direct `c.env.set` access — the SDK child env
 * — still sees the real value.
 */
function makeCredential(pub: Omit<Credential, 'env'>, env: Credential['env']): Credential {
  const view = { ...pub };
  const redacted = () => ({ set: Object.keys(env.set), unset: [...env.unset] });
  Object.defineProperty(env, 'toJSON', { value: redacted, enumerable: false });
  Object.defineProperty(env, inspect.custom, { value: redacted, enumerable: false });
  const c = { ...pub } as Credential;
  Object.defineProperty(c, 'env', { value: env, enumerable: false });
  Object.defineProperty(c, 'toJSON', { value: () => ({ ...view }), enumerable: false });
  return c;
}

/** Human-readable label; never includes the secret. */
export function describe(c: Credential): string {
  return `${c.name} (${c.kind}, ${c.fingerprint})`;
}
