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

export function resolveUserDataDir(opts?: Resolver): string {
  const env = resolveEnv(opts);
  if (env.ROBIN_USER_DATA_DIR) return env.ROBIN_USER_DATA_DIR;
  const home = resolveHome(opts);
  const xdgData = env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  return join(xdgData, 'robin');
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
export const socketFilePath = (root: string) => join(root, 'state', 'runtime', 'robin.sock');
