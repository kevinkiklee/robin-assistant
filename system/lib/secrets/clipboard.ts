import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface ClipboardIO {
  read(): string;
  clear(): void;
  notify(title: string, body: string): void;
}

/** Escape a string for use inside an AppleScript double-quoted literal. */
function asString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export const macClipboard: ClipboardIO = {
  read: () => execFileSync('pbpaste', [], { encoding: 'utf8' }),
  clear: () => {
    execFileSync('pbcopy', [], { input: '' });
  },
  notify: (title, body) => {
    try {
      execFileSync(
        'osascript',
        ['-e', `display notification ${asString(body)} with title ${asString(title)}`],
        { stdio: 'ignore' },
      );
    } catch {
      // A missed banner must not break the flow.
    }
  },
};

export function hashText(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export type FreshCopy =
  | { ok: true; value: string }
  | { ok: false; reason: 'unchanged' | 'empty' | 'shape' };

export function takeFreshCopy(io: ClipboardIO, sinceHash: string, shape: RegExp): FreshCopy {
  const raw = io.read();
  if (raw === '') return { ok: false, reason: 'empty' };
  if (hashText(raw) === sinceHash) return { ok: false, reason: 'unchanged' };
  const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (value === '') return { ok: false, reason: 'empty' };
  if (!shape.test(value)) return { ok: false, reason: 'shape' };
  return { ok: true, value };
}

export async function waitForFreshCopy(
  io: ClipboardIO,
  sinceHash: string,
  shape: RegExp,
  opts: {
    timeoutMs: number;
    pollMs: number;
    sleep?: (ms: number) => Promise<void>;
    message: string;
  },
): Promise<{ ok: true; value: string } | { ok: false; reason: 'timeout' }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  io.notify('Robin secret', opts.message);
  for (let elapsed = 0; elapsed <= opts.timeoutMs; elapsed += opts.pollMs) {
    const r = takeFreshCopy(io, sinceHash, shape);
    if (r.ok) return r;
    await sleep(opts.pollMs);
  }
  return { ok: false, reason: 'timeout' };
}
