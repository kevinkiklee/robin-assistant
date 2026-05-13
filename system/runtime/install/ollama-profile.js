// Profile validation + auto-start + auto-pull for the qwen3-4096 embedder
// (which runs against a local Ollama server). Extracted out of install.js
// so the install orchestrator stays focused on flow and these helpers
// stay testable in isolation.

import { spawn, spawnSync } from 'node:child_process';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const OLLAMA_MODEL = 'qwen3-embedding:8b';
// Time budget for `ollama serve` to come up after we spawn it. The daemon
// usually answers within a few seconds; 20s is the generous "cold start +
// model loading slot is free" upper bound.
const OLLAMA_START_TIMEOUT_MS = 20000;
const OLLAMA_POLL_INTERVAL_MS = 500;

function whichOllama(spawnSyncFn = spawnSync) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSyncFn(finder, ['ollama'], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.trim().split(/\r?\n/)[0] || null;
}

async function fetchOllamaTags(fetchFn) {
  try {
    const resp = await fetchFn(`${OLLAMA_HOST}/api/tags`);
    if (!resp.ok) return { ok: false, status: resp.status };
    return { ok: true, json: await resp.json() };
  } catch (e) {
    return { ok: false, error: e };
  }
}

async function waitForOllama(
  fetchFn,
  { timeoutMs = OLLAMA_START_TIMEOUT_MS, intervalMs = OLLAMA_POLL_INTERVAL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetchOllamaTags(fetchFn);
    if (r.ok) return r;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return null;
}

/**
 * Probe for the Ollama server. If unreachable, auto-spawn `ollama serve`
 * when the binary is on PATH; otherwise error with install instructions.
 * After the server is up, ensure the qwen3-embedding:8b model is pulled
 * (and pull it if not — this can be a ~16 GB download).
 *
 * On any unrecoverable failure this calls process.exit(1). Tests can pin
 * the four function deps (`whichFn`, `spawnFn`, `spawnSyncFn`, `fetchFn`)
 * to avoid touching real binaries or sockets.
 */
export async function validateOllama({
  fetchFn,
  whichFn = whichOllama,
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
  startTimeoutMs = OLLAMA_START_TIMEOUT_MS,
}) {
  let r = await fetchOllamaTags(fetchFn);

  if (!r.ok) {
    const ollamaBin = whichFn(spawnSyncFn);
    if (!ollamaBin) {
      const reason = r.error?.message ?? `HTTP ${r.status}`;
      console.error(`Ollama unreachable at ${OLLAMA_HOST}: ${reason}`);
      console.error('`ollama` is not on PATH. Install it:');
      console.error('  brew install ollama        # macOS');
      console.error('  curl -fsSL https://ollama.com/install.sh | sh   # Linux');
      console.error('Then re-run `robin install`.');
      process.exit(1);
    }
    console.log(
      `Ollama not running at ${OLLAMA_HOST}; starting \`ollama serve\` in the background…`,
    );
    const child = spawnFn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
    child.unref?.();
    r = await waitForOllama(fetchFn, { timeoutMs: startTimeoutMs });
    if (!r) {
      console.error(`Ollama failed to start within ${Math.round(startTimeoutMs / 1000)}s.`);
      console.error(
        'Try `ollama serve` manually, check ~/.ollama/logs, then re-run `robin install`.',
      );
      process.exit(1);
    }
    console.log(`Ollama is running at ${OLLAMA_HOST}.`);
  }

  const installed = (r.json.models ?? []).map((m) => m.name);
  const found = installed.some((n) => n.startsWith(OLLAMA_MODEL));
  if (!found) {
    console.log(`Pulling ${OLLAMA_MODEL} (~16 GB, this can take a while)…`);
    const res = spawnSyncFn('ollama', ['pull', OLLAMA_MODEL], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`\`ollama pull ${OLLAMA_MODEL}\` failed (exit ${res.status}).`);
      console.error('Run it manually once the issue is resolved, then re-run `robin install`.');
      process.exit(1);
    }
  }
}
