import { spawn } from 'node:child_process';
import type { InvokeRequest, InvokeResult, LLMProvider, LLMRole, ProviderMeta } from './types.ts';

// Per-tier model mapping. Callers pick via `model` config; defaults to flash.
const TIER_MODEL: Record<string, string> = {
  fast: 'gemini-2.5-flash-lite',
  balanced: 'gemini-2.5-flash',
  deep: 'gemini-2.5-pro',
};

export interface GeminiProviderConfig {
  command?: string;
  model?: string; // explicit model string, e.g. 'gemini-2.5-flash'. Overrides `tier`.
  tier?: 'fast' | 'balanced' | 'deep';
  capabilities?: LLMRole[];
  meta?: Partial<ProviderMeta>;
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini-cli';
  readonly capabilities: Set<LLMRole>;
  readonly meta: ProviderMeta;
  private command: string;
  private model: string;

  constructor(cfg: GeminiProviderConfig = {}) {
    this.command = cfg.command ?? 'gemini';
    this.model = cfg.model ?? TIER_MODEL[cfg.tier ?? 'balanced'] ?? TIER_MODEL.balanced;
    this.capabilities = new Set(
      cfg.capabilities ?? ['interactive', 'agentic', 'reasoning', 'summarize', 'classify'],
    );
    this.meta = {
      contextWindow: cfg.meta?.contextWindow ?? 1_000_000,
      inputPricePerM: cfg.meta?.inputPricePerM ?? 0,
      outputPricePerM: cfg.meta?.outputPricePerM ?? 0,
    };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const start = Date.now();
    const prompt = this.buildPrompt(req);
    // `--approval-mode plan` is critical: it removes run_shell_command and
    // sandboxes write_file. Without it, gemini CLI is an agent that can
    // execute tool calls and touch the filesystem in response to prompts.
    const out = await this.runProcess([
      '-p',
      prompt,
      '-o',
      'json',
      '-m',
      this.model,
      '--approval-mode',
      'plan',
    ]);
    let text = out;
    let usage: InvokeResult['usage'] = { inputTokens: 0, outputTokens: 0 };
    try {
      const parsed = JSON.parse(out) as {
        response?: string;
        text?: string;
        result?: string;
        stats?: { models?: Record<string, { tokens?: Record<string, number> }> };
      };
      text = parsed.response ?? parsed.result ?? parsed.text ?? out;
      if (parsed.stats?.models) {
        let input = 0;
        let output = 0;
        let cached = 0;
        for (const m of Object.values(parsed.stats.models)) {
          input += m?.tokens?.prompt ?? 0;
          output += m?.tokens?.candidates ?? 0;
          cached += m?.tokens?.cached ?? 0;
        }
        usage = { inputTokens: input, outputTokens: output, cachedInputTokens: cached };
      }
    } catch {
      // not JSON; treat as plain text
    }
    return {
      text,
      usage,
      costUsd: 0,
      latencyMs: Date.now() - start,
      provider: this.name,
    };
  }

  private buildPrompt(req: InvokeRequest): string {
    const sys = req.systemPrompt ? `[SYSTEM]\n${req.systemPrompt}\n\n` : '';
    const turns = req.messages.map((m) => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n');
    return `${sys}${turns}`;
  }

  private runProcess(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`gemini-cli exited ${code}: ${stderr}`));
      });
    });
  }
}
