import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isHookDisabled } from '../../config/hooks-disabled.js';

export const DISPATCH = {
  discretion: {
    module: '../../cognition/discretion/handler.js',
    exportName: 'discretionHandler',
  },
  intuition: { module: '../../cognition/intuition/handler.js', exportName: 'intuitionHandler' },
  'session-start': { module: './session-start.js', exportName: 'sessionStartHandler' },
  stop: { module: './stop-hook.js', exportName: 'stopHookHandler' },
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
  // Fail-soft envelope around the ENTIRE hook body (kill-switch lookup +
  // stdin read + handler dispatch). isHookDisabled hits readConfig which
  // throws when Robin isn't installed; without this catch, a stale hook
  // entry on an uninstalled Robin would crash the host's hook line. Handlers
  // that want to *block* the host's tool call still must call
  // process.exit(2) themselves.
  try {
    if (await isHookDisabled(phase)) return;
    const raw = opts.rawStdin ?? (await readStdin());
    const stdin = parseJson(raw);
    const mod = await import(entry.module);
    const handler = mod[entry.exportName];
    if (typeof handler !== 'function') return;
    await handler({ stdin });
  } catch (e) {
    // Errors swallowed silently here are nearly invisible because hooks run
    // inside Claude/Gemini's stdio capture, so opt-in surfacing is gated by
    // ROBIN_DEBUG to keep normal sessions noise-free.
    if (process.env.ROBIN_DEBUG) {
      console.error(`[hook:${phase}] ${e?.name ?? 'Error'}: ${e?.message ?? e}`);
    }
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
