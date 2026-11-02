import { resolveUserDataDir } from '../../lib/paths.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';

/**
 * Load the instance's secrets (`.env`, and the VM's `daemon.env`) once, before
 * any CLI command dispatches, so every command — `robin agent`, `robin
 * biographer`, … — runs through the credential chain rather than the ambient
 * login. Never overrides an already-set key; per-command loads stay harmless.
 * A missing or unresolvable user-data dir never breaks a command (`init`,
 * `--help`).
 */
export function loadCliEnv(
  deps: { resolve?: () => string; load?: (userDataDir: string) => unknown } = {},
): void {
  try {
    const dir = (deps.resolve ?? resolveUserDataDir)();
    (deps.load ?? loadEnvFile)(dir);
  } catch {
    // no instance yet — commands that need one report it themselves
  }
}
