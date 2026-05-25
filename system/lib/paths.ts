import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface Env {
  ROBIN_USER_DATA_DIR?: string;
  XDG_DATA_HOME?: string;
  XDG_CONFIG_HOME?: string;
  XDG_CACHE_HOME?: string;
}

interface Resolver {
  env?: Env;
  home?: string;
}

function resolveHome(opts?: Resolver): string {
  return opts?.home ?? homedir();
}

function resolveEnv(opts?: Resolver): Env {
  return opts?.env ?? (process.env as Env);
}

/** Name of the instance-pointer file under the config dir. */
const POINTER_FILE = 'user-data-dir';

/** Absolute path to the instance-pointer file (config dir + user-data-dir). */
export function userDataPointerPath(opts?: Resolver): string {
  return join(resolveConfigDir(opts), POINTER_FILE);
}

/**
 * Read the instance-pointer file, if present and non-empty. Returns the trimmed
 * absolute path, or undefined if the file is missing/empty/unreadable. Pure-ish:
 * any filesystem error is swallowed so resolution can fall through to XDG.
 */
function readUserDataPointer(opts?: Resolver): string | undefined {
  try {
    const contents = readFileSync(userDataPointerPath(opts), 'utf8').trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolution order: ROBIN_USER_DATA_DIR env → instance-pointer file
 * (<configDir>/user-data-dir) → XDG default (~/.local/share/robin). The pointer
 * lets bare CLI invocations find the installed instance even when the env var
 * isn't set (e.g. a shell outside the launchd plist's environment).
 */
export function resolveUserDataDir(opts?: Resolver): string {
  const env = resolveEnv(opts);
  if (env.ROBIN_USER_DATA_DIR) return env.ROBIN_USER_DATA_DIR;
  const pointer = readUserDataPointer(opts);
  if (pointer) return pointer;
  const home = resolveHome(opts);
  const xdgData = env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  return join(xdgData, 'robin');
}

/**
 * Write the instance-pointer file so future bare CLI invocations resolve to
 * `dir`. Ensures the config dir exists first. `dir` is recorded verbatim — the
 * caller is responsible for passing an absolute path.
 */
export function writeUserDataPointer(dir: string, opts?: Resolver): string {
  const pointerPath = userDataPointerPath(opts);
  mkdirSync(resolveConfigDir(opts), { recursive: true });
  writeFileSync(pointerPath, `${dir}\n`);
  return pointerPath;
}

export function resolveConfigDir(opts?: Resolver): string {
  const env = resolveEnv(opts);
  const home = resolveHome(opts);
  const xdgConfig = env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(xdgConfig, 'robin');
}

export function userDataPaths(root: string) {
  return {
    root,
    state: {
      db: join(root, 'state', 'db'),
      kuzu: join(root, 'state', 'kuzu'),
      runtime: join(root, 'state', 'runtime'),
      migrations: join(root, 'state', 'migrations'),
    },
    config: {
      root: join(root, 'config'),
      secrets: join(root, 'config', 'secrets'),
      templates: join(root, 'config', 'templates'),
    },
    extensions: {
      root: join(root, 'extensions'),
      integrations: join(root, 'extensions', 'integrations'),
      jobs: join(root, 'extensions', 'jobs'),
      triggers: join(root, 'extensions', 'triggers'),
      scripts: join(root, 'extensions', 'scripts'),
      skills: join(root, 'extensions', 'skills'),
    },
    content: {
      artifacts: join(root, 'content', 'artifacts'),
      sources: join(root, 'content', 'sources'),
    },
    observability: {
      logs: join(root, 'observability', 'logs'),
      eval: join(root, 'observability', 'eval'),
    },
  };
}

export const dbFilePath = (root: string) => join(root, 'state', 'db', 'robin.sqlite');
export const pidFilePath = (root: string) => join(root, 'state', 'runtime', 'daemon.pid');
