import { spawn as nodeSpawn } from 'node:child_process';
import { CLAUDE_TIER_MAP, DEFAULT_TIER } from './interface.js';

function runClaude(spawnFn, args, stdin) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
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
    name: 'claude_code',

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
      const payload = {
        model,
        messages,
        system: opts.system ?? [],
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      };
      const out = await runClaude(spawnFn, ['invokeLLM'], JSON.stringify(payload));
      const parsed = JSON.parse(out);
      return {
        content: parsed.content,
        usage: parsed.usage ?? { input_tokens: 0, output_tokens: 0 },
      };
    },
  };
}

export const claudeCodeAdapter = createClaudeCodeAdapter();
