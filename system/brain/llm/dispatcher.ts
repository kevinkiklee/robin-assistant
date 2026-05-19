import type { LLMProvider, LLMRole, InvokeRequest, InvokeResult } from './types.ts';

export class LLMDispatcher {
  private providers = new Map<string, LLMProvider>();
  private roleAssignments = new Map<LLMRole, string>();

  register(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  assign(role: LLMRole, providerName: string): void {
    if (!this.providers.has(providerName)) {
      throw new Error(`Provider '${providerName}' not registered`);
    }
    this.roleAssignments.set(role, providerName);
  }

  getProvider(role: LLMRole): LLMProvider {
    const name = this.roleAssignments.get(role);
    if (!name) throw new Error(`No provider assigned for role '${role}'`);
    const p = this.providers.get(name);
    if (!p) throw new Error(`Provider '${name}' missing (assigned but not registered)`);
    return p;
  }

  invoke(role: LLMRole, req: InvokeRequest): Promise<InvokeResult> {
    return this.getProvider(role).invoke(req);
  }

  embed(role: LLMRole, text: string | string[]): Promise<number[][]> {
    const p = this.getProvider(role);
    if (!p.embed) throw new Error(`Provider '${p.name}' does not support embeddings`);
    return p.embed(text);
  }
}
