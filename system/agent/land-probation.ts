// Post-restart probation for an auto-landed fix. Tests and a clean build can't
// prove the daemon still boots and stays up; an unattended land that crash-loops
// the daemon would leave Robin down until the operator noticed. So after the
// restart a detached shell runs this check: if the daemon isn't up and settled,
// it reverts the merge, rebuilds, restarts, and says so in Discord.
//
// Invoked as `tsx system/agent/land-probation.ts --commit=<merge> --branch=<b>`
// from restartDaemonSoon(); exported pieces are unit-tested.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notifyDiscordAction } from '../integrations/builtin/discord/index.ts';
import { appendLandLog } from '../lib/land-log.ts';
import { resolveUserDataDir } from '../lib/paths.ts';
import { loadEnvFile } from '../lib/secrets/load-env.ts';

/** The daemon must have stayed up this long to count as settled. */
export const SETTLED_SEC = 60;

/** Parse macOS `ps -o etime=` (`[[dd-]hh:]mm:ss`) into seconds; NaN if malformed. */
export function parseEtime(s: string): number {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return Number.NaN;
  const [, d, h, min, sec] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min)) * 60 + Number(sec);
}

export interface ProbationDeps {
  /** Seconds the daemon has been up, or null when it isn't running. */
  daemonUptimeSec: () => number | null;
  sleep: (ms: number) => Promise<void>;
  revert: () => void;
}

/**
 * Healthy when the daemon is up and has stayed up ≥ SETTLED_SEC. One re-check a
 * minute later absorbs an unrelated restart (another session's kickstart) landing
 * on the first look; still unhealthy → revert.
 */
export async function runProbation(deps: ProbationDeps): Promise<'healthy' | 'reverted'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const up = deps.daemonUptimeSec();
    if (up !== null && up >= SETTLED_SEC) return 'healthy';
    if (attempt === 0) await deps.sleep(SETTLED_SEC * 1000);
  }
  deps.revert();
  return 'reverted';
}

function realUptime(userDataDir: string): number | null {
  try {
    const pid = Number.parseInt(
      readFileSync(join(userDataDir, 'state', 'runtime', 'daemon.pid'), 'utf8'),
      10,
    );
    if (!Number.isFinite(pid)) return null;
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
    const sec = parseEtime(out);
    return Number.isFinite(sec) ? sec : null;
  } catch {
    return null; // no pid file, or the process is gone
  }
}

async function main(): Promise<void> {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const commit = arg('commit');
  const branch = arg('branch') ?? '';
  if (!commit) {
    process.stderr.write('land-probation: --commit required\n');
    process.exit(2);
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const userDataDir = resolveUserDataDir();
  loadEnvFile(userDataDir);
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { cwd: repoRoot, stdio: 'pipe', timeout: 600_000 });

  let detail = '';
  const result = await runProbation({
    daemonUptimeSec: () => realUptime(userDataDir),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    revert: () => {
      try {
        run('git', ['revert', '-m', '1', '--no-edit', commit]);
        run('pnpm', ['build']);
        detail = 'reverted, rebuilt';
      } catch (err) {
        detail = `revert/rebuild FAILED — main needs attention: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
      }
      run('launchctl', [
        'kickstart',
        '-k',
        `gui/${process.getuid?.() ?? 501}/io.robin-assistant.daemon`,
      ]);
    },
  });
  appendLandLog(userDataDir, {
    branch,
    landed: result === 'healthy',
    reason:
      result === 'healthy'
        ? `probation passed for ${commit}`
        : `probation failed for ${commit}: ${detail}`,
    files: [],
    commit,
  });
  if (result === 'reverted') {
    await notifyDiscordAction({
      title: 'Robin auto-fix reverted',
      message: `${commit} (${branch}): the daemon didn't stay up after the restart — ${detail}`,
      mention: false,
      silent: true,
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    process.stderr.write(`land-probation: fatal: ${err instanceof Error ? err.stack : err}\n`);
    process.exit(1);
  });
}
