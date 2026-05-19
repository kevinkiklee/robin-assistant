import { spawn } from 'node:child_process';
import type { InvokeRequest, InvokeResult, LLMProvider, LLMRole, ProviderMeta } from './types.ts';

export interface ClaudeCodeProviderConfig {
  command?: string;
  capabilities?: LLMRole[];
  meta?: Partial<ProviderMeta>;
}

export class ClaudeCodeProvider implements LLMProvider {
  readonly name = 'claude-code';
  readonly capabilities: Set<LLMRole>;
  readonly meta: ProviderMeta;
  private command: string;

  constructor(cfg: ClaudeCodeProviderConfig = {}) {
    this.command = cfg.command ?? 'claude';
    this.capabilities = new Set(cfg.capabilities ?? ['interactive', 'agentic', 'reasoning']);
    this.meta = {
      contextWindow: cfg.meta?.contextWindow ?? 200_000,
      inputPricePerM: 0,
      outputPricePerM: 0,
    };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const start = Date.now();
    const prompt = this.buildPrompt(req);
    const out = await this.runProcess(['-p', prompt, '--output-format', 'json']);
    let text = out;
    try {
      const parsed = JSON.parse(out) as { result?: string; text?: string };
      text = parsed.result ?? parsed.text ?? out;
    } catch {
      // not JSON; treat as plain text
    }
    return {
      text,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: Date.now() - start,
      provider: this.name,
    };
  }

  private buildPrompt(req: InvokeRequest): string {
    const sys = req.systemPrompt ? `[SYSTEM]\n${req.systemPrompt}\n\n` : '';
    const turns = req.messages
      .map((m) => `[${m.role.toUpperCase()}]\n${m.content}`)
      .join('\n\n');
    return `${sys}${turns}`;
  }

  private runProcess(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`claude-code exited ${code}: ${stderr}`));
      });
    });
  }
}
