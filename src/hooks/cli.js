import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isHookDisabled } from './disabled.js';

export const DISPATCH = {
  discretion: { module: './handlers/discretion.js', exportName: 'discretionHandler' },
  intuition: { module: './handlers/intuition.js', exportName: 'intuitionHandler' },
  'session-start': { module: './handlers/session-start.js', exportName: 'sessionStartHandler' },
  stop: { module: './handlers/stop-hook.js', exportName: 'stopHookHandler' },
};

async function readStdin(timeoutMs = 1000) {
  if (process.stdin.isTTY) return '';
  return await new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), timeoutMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(''));
  });
}

function parseJson(raw) {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function runHook(phase, opts = {}) {
  const entry = DISPATCH[phase];
  if (!entry) return;
  if (await isHookDisabled(phase)) return;
  const raw = opts.rawStdin ?? (await readStdin());
  const stdin = parseJson(raw);
  try {
    const mod = await import(entry.module);
    const handler = mod[entry.exportName];
    if (typeof handler !== 'function') return;
    await handler({ stdin });
  } catch {
    // fail-soft: handlers that want to block must call process.exit(2) themselves.
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    return realpathSync(process.argv[1]) === realpathSync(here);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const phase = process.argv[2];
  if (phase) await runHook(phase);
  process.exit(0);
}
