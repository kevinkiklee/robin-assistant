import { spawn as nodeSpawn } from 'node:child_process';
import { CLAUDE_TIER_MAP, DEFAULT_TIER } from './interface.js';

function runClaude(spawnFn, args, stdin, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let proc;
    try {
      proc = spawnFn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
        // Process may have already exited — ignore.
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
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

// Claude Code CLI takes a single prompt string as a positional arg under
// `-p / --print`. Concatenate any system messages + the conversation into
// one prompt, mirroring the Gemini adapter so v1's role-prefixed pattern
// carries over.
function messagesToPrompt(messages, system) {
  const sysText = (system ?? []).map((s) => s.content).join('\n\n');
  const conv = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  return sysText ? `${sysText}\n\n${conv}` : conv;
}

// Real `claude -p --output-format=json` envelope is
// `{ type: 'result', result: '<text>', usage: { input_tokens, output_tokens, cache_read_input_tokens, ... } }`.
// We normalize usage to the shape the rest of v2 expects.
function summarizeUsage(envelope) {
  const u = envelope?.usage ?? {};
  return {
    input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    output_tokens: u.output_tokens ?? u.candidates_tokens ?? 0,
    cache_read_tokens: u.cache_read_tokens ?? u.cache_read_input_tokens ?? 0,
  };
}

/**
 * Build a Claude Code host adapter. The `spawn` dependency is injected so
 * tests can swap in a fake without touching the real subprocess.
 *
 * @param {{ spawn?: typeof import('node:child_process').spawn }} [deps]
 * @returns {import('./interface.js').HostAdapter}
 */
export function createClaudeCodeAdapter(deps = {}) {
  const spawnFn = deps.spawn ?? nodeSpawn;

  return {
    name: 'claude-code',

    async isAvailable() {
      try {
        await runClaude(spawnFn, ['--version'], undefined);
        return true;
      } catch {
        return false;
      }
    },

    async invokeLLM(messages, opts = {}) {
      const tier = opts.tier ?? DEFAULT_TIER;
      const model = CLAUDE_TIER_MAP[tier];
      const prompt = messagesToPrompt(messages, opts.system);
      const args = ['-p', prompt, '--output-format=json', '--model', model];
      const out = await runClaude(spawnFn, args, undefined, opts.signal);
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch (e) {
        throw new Error(`claude stdout was not valid JSON: ${e.message}`);
      }
      const content = parsed.result ?? parsed.content ?? '';
      return {
        content,
        usage: summarizeUsage(parsed),
      };
    },
  };
}

export const claudeCodeAdapter = createClaudeCodeAdapter();
