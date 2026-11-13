// macOS helpers the key manager runs. An agent controls PATH (and could drop a
// fake `osascript` that "clicks" Send, or a fake `pbpaste`), so every helper is
// run by absolute path with a fixed minimal environment — never a PATH lookup.

import { type ExecFileSyncOptions, execFileSync } from 'node:child_process';

export const MAC_TOOLS = {
  osascript: '/usr/bin/osascript',
  pbpaste: '/usr/bin/pbpaste',
  pbcopy: '/usr/bin/pbcopy',
  launchctl: '/bin/launchctl',
} as const;

/** The only environment a helper sees. */
export const TOOL_ENV: NodeJS.ProcessEnv = Object.freeze({ PATH: '/usr/bin:/bin' });

export type ExecFn = (file: string, args: string[], opts: ExecFileSyncOptions) => string | Buffer;

export const realExec: ExecFn = (file, args, opts) => execFileSync(file, args, opts);
