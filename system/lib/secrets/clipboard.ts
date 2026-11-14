import { createHash } from 'node:crypto';
import { type ExecFn, MAC_TOOLS, realExec, TOOL_ENV } from './mac-tools.ts';

export interface ClipboardIO {
  read(): string;
  clear(): void;
  notify(title: string, body: string): void;
}

/** Escape a string for use inside an AppleScript double-quoted literal. */
function asString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The pbpaste/pbcopy/osascript clipboard, run by absolute path (see mac-tools.ts). */
export function macClipboardWith(exec: ExecFn): ClipboardIO {
  return {
    read: () => String(exec(MAC_TOOLS.pbpaste, [], { encoding: 'utf8', env: TOOL_ENV })),
    clear: () => {
      exec(MAC_TOOLS.pbcopy, [], { input: '', env: TOOL_ENV });
    },
    notify: (title, body) => {
      try {
        exec(
          MAC_TOOLS.osascript,
          ['-e', `display notification ${asString(body)} with title ${asString(title)}`],
          { stdio: 'ignore', env: TOOL_ENV },
        );
      } catch {
        // A missed banner must not break the flow.
      }
    },
  };
}

export const macClipboard: ClipboardIO = macClipboardWith(realExec);

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
  // Keys never contain whitespace, so surrounding whitespace from a manual
  // selection is dropped. If the selection caught extra words (a label, the
  // whole line), use the one token that has the key's shape — only when exactly
  // one does.
  const value = raw.trim();
  if (value === '') return { ok: false, reason: 'empty' };
  if (shape.test(value)) return { ok: true, value };
  const hits = value.split(/[\s=:,;"'`()<>[\]{}]+/).filter((t) => t !== '' && shape.test(t));
  if (hits.length === 1) return { ok: true, value: hits[0] };
  return { ok: false, reason: 'shape' };
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
): Promise<{ ok: true; value: string } | { ok: false; reason: 'timeout' | 'shape' }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  io.notify('Robin secret', opts.message);
  let sawWrongShape = false;
  for (let elapsed = 0; elapsed <= opts.timeoutMs; elapsed += opts.pollMs) {
    const r = takeFreshCopy(io, sinceHash, shape);
    if (r.ok) return r;
    if (r.reason === 'shape') sawWrongShape = true;
    await sleep(opts.pollMs);
  }
  // A copy arrived but never looked like a key: say so instead of "no copy".
  return { ok: false, reason: sawWrongShape ? 'shape' : 'timeout' };
}
