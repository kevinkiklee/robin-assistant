import type { Credential } from '../../agent/credentials/config.ts';
import { describe, loadCredentials } from '../../agent/credentials/config.ts';
import { effectiveLimit } from '../../agent/credentials/select.ts';
import { type ChainState, CredentialStateStore, statePath } from '../../agent/credentials/state.ts';
import { loadPolicies } from '../../kernel/config/load.ts';
import { daysLeft } from '../../kernel/invariants/builtins/credentials-expiring.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';

const FAMILIES = ['all', 'opus', 'sonnet'] as const;

function localTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Limit windows for the other families fold into `all` only via effectiveLimit('other'). */
function familyStatus(
  cs: ChainState['credentials'][string] | undefined,
  family: (typeof FAMILIES)[number],
  nowMs: number,
): string {
  const level = effectiveLimit(cs, family === 'all' ? 'other' : family, nowMs);
  if (level === 'ok') return `${family} ok`;
  if (level === 'warning') return `${family} warning`;
  const until = (cs?.limits ?? [])
    .filter((l) => l.status === 'rejected' && (l.scope === 'all' || l.scope === family))
    .map((l) => l.resetsAtMs ?? l.observedAtMs + 30 * 60_000)
    .filter((t) => t > nowMs);
  const when = until.length ? localTime(Math.max(...until)) : 'further notice';
  return `${family} limited until ${when}`;
}

export function renderAccounts(args: {
  credentials: Credential[];
  state: ChainState;
  mode: 'auto' | 'manual';
  nowMs: number;
}): string {
  const { credentials, state, mode, nowMs } = args;
  if (credentials.length === 0) {
    return 'No Claude credentials configured — using the local claude login.';
  }
  const lines = [`Claude credentials (rotation: ${mode})`];
  for (const c of credentials) {
    const cs = state.credentials[c.id];
    const parts = FAMILIES.map((f) => familyStatus(cs, f, nowMs));
    parts.push(
      cs?.firstSeenAtMs === undefined
        ? 'not yet used'
        : `expires in ${Math.max(daysLeft(cs.firstSeenAtMs, nowMs), 0)}d`,
    );
    if (cs?.lastUsedAtMs !== undefined) parts.push(`last used ${localTime(cs.lastUsedAtMs)}`);
    if (mode === 'manual' && c.kind === 'subscription' && state.pinned === c.name) {
      parts.push('pinned');
    }
    lines.push(`${describe(c)}  ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

export function accountsUse(args: {
  userData: string;
  env: Record<string, string | undefined>;
  name: string | undefined;
}): { code: number; message: string } {
  const configured = loadCredentials(args.env)
    .filter((c) => c.kind === 'subscription')
    .map((c) => c.name as string);
  if (args.name !== 'robin' && args.name !== 'shared') {
    return { code: 1, message: 'usage: robin accounts use <robin|shared>' };
  }
  if (!configured.includes(args.name)) {
    return {
      code: 1,
      message: `${args.name} is not configured (no CLAUDE_TOKEN_${args.name.toUpperCase()} set).`,
    };
  }
  const name = args.name;
  new CredentialStateStore(statePath(args.userData)).update((s) => {
    s.pinned = name;
  });
  return {
    code: 0,
    message: `Pinned ${name}. Takes effect in manual rotation (agent.account_rotation: manual).`,
  };
}

export async function runAccountsCommand(args: string[]): Promise<void> {
  const userData = resolveUserDataDir();
  loadEnvFile(userData);
  if (args[0] === 'use') {
    const r = accountsUse({ userData, env: process.env, name: args[1] });
    (r.code === 0 ? console.log : console.error)(r.message);
    process.exitCode = r.code;
    return;
  }
  if (args.length > 0) {
    console.error('usage: robin accounts [use <robin|shared>]');
    process.exitCode = 2;
    return;
  }
  console.log(
    renderAccounts({
      credentials: loadCredentials(process.env),
      state: new CredentialStateStore(statePath(userData)).read(),
      mode: loadPolicies(userData).agent.account_rotation,
      nowMs: Date.now(),
    }),
  );
}
