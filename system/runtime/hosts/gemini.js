import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { DEFAULT_TIER, GEMINI_TIER_MAP } from './interface.js';

function messagesToPrompt(messages, system) {
  // Gemini CLI takes a single prompt string. Concatenate system + messages.
  const sysText = (system ?? []).map((s) => s.content).join('\n\n');
  const conv = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  return sysText ? `${sysText}\n\n${conv}` : conv;
}

// Gemini CLI manages context caching transparently — there's no cachedContent
// resource lifecycle for v2 to manage. The CLI's stats.models[*].tokens.cached
// field reports how many tokens were cache-hit per call; we surface that as
// usage.cache_read_tokens so callers can observe cache effectiveness without
// owning the cache. (Path B with direct Google API would require lifecycle
// management; Path A delegates it to the CLI.)
function summarizeUsage(stats) {
  // Per the spike note, the real Gemini CLI returns `stats.models` as an
  // object keyed by model name, with per-model `tokens.{prompt,candidates,cached,...}`.
  // `candidates` is the equivalent of "output_tokens" (the model's response tokens).
  if (!stats?.models || typeof stats.models !== 'object') {
    return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
  }
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const m of Object.values(stats.models)) {
    input += m?.tokens?.prompt ?? 0;
    output += m?.tokens?.candidates ?? 0;
    cached += m?.tokens?.cached ?? 0;
  }
  return { input_tokens: input, output_tokens: output, cache_read_tokens: cached };
}

function runGemini(spawnFn, args, stdin, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let proc;
    try {
      // Neutral cwd to avoid v1 project hooks firing during a Robin-internal
      // LLM call. Also strip GEMINI_PROJECT_DIR from the inherited env so the
      // child can't pick it up — assigning `undefined` would coerce to the
      // literal string "undefined", so we omit it via destructuring instead.
      const { GEMINI_PROJECT_DIR: _stripped, ...env } = process.env;
      proc = spawnFn('gemini', args, {
        cwd: tmpdir(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already exited — ignore.
      }
      reject(new Error('aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(e);
    });
    proc.on('exit', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) return;
      if (code !== 0) reject(new Error(`gemini exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

/**
 * Build a Gemini CLI host adapter. The `spawn` dependency is injected so
 * tests can swap in a fake without launching the real `gemini` binary.
 *
 * @param {{ spawn?: typeof import('node:child_process').spawn }} [deps]
 * @returns {import('./interface.js').HostAdapter}
 */
export function createGeminiAdapter(deps = {}) {
  const spawnFn = deps.spawn ?? nodeSpawn;

  return {
    name: 'gemini-cli',

    async isAvailable() {
      try {
        await runGemini(spawnFn, ['--version'], undefined);
        return true;
      } catch {
        return false;
      }
    },

    async invokeLLM(messages, opts = {}) {
      const tier = opts.tier ?? DEFAULT_TIER;
      const model = GEMINI_TIER_MAP[tier];
      const prompt = messagesToPrompt(messages, opts.system);
      const args = ['-p', prompt, '-o', 'json', '-m', model];
      const out = await runGemini(spawnFn, args, undefined, opts.signal);
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch (e) {
        throw new Error(`gemini stdout was not valid JSON: ${e.message}`);
      }
      return {
        content: parsed.response ?? '',
        usage: summarizeUsage(parsed.stats),
      };
    },
  };
}

export const geminiAdapter = createGeminiAdapter();
