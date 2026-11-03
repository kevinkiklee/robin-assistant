import { resolve } from 'node:path';
import { type CloudCmd, runCloud } from '../../lib/cloud/migrate.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';

const SUBCOMMANDS: readonly CloudCmd[] = ['status', 'dry-run', 'cutover', 'rollback'];

const USAGE = `usage: robin cloud <status|dry-run|cutover|rollback> --host <ssh-alias> [--yes] [--accept-gaps]

  status     both roles, both daemons, and which side is the writer (changes nothing)
  dry-run    copy this Mac's data to a held VM (the Mac keeps running; repeat freely)
  cutover    lock this Mac and make the VM the writer (asks you to type "cutover")
  rollback   bring the VM's data home and unlock this Mac (asks you to type "rollback")

See docs/CLOUD-VM.md, "Moving Robin".`;

/** `--host x` or `--host=x`. */
function flagValue(args: string[], name: string): string | undefined {
  for (const [i, a] of args.entries()) {
    if (a === name) return args[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

export async function runCloudCommand(args: string[]): Promise<number> {
  /* biome-ignore-start lint/suspicious/noConsole: CLI output */
  const sub = args[0] as CloudCmd | undefined;
  const host = flagValue(args, '--host');
  if (!sub || !SUBCOMMANDS.includes(sub) || !host || host.startsWith('-')) {
    console.error(USAGE);
    return 2;
  }
  // The checkout this CLI runs from: system/surfaces/cli (tsx) or dist/surfaces/cli.
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  /* biome-ignore-end lint/suspicious/noConsole: CLI output */
  return runCloud(sub, {
    host,
    userData: resolveUserDataDir(),
    repoRoot,
    yes: args.includes('--yes') || args.includes('-y'),
    acceptGaps: args.includes('--accept-gaps'),
    acceptTokenReset: args.includes('--accept-token-reset'),
  });
}
