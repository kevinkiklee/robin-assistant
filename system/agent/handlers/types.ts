import type { RunAgentInput } from '../run-agent.ts';

/** Context threaded into a handler's `build()` so it can resolve paths. */
export interface HandlerCtx {
  /** Repo root for the live instance. */
  repoRoot: string;
  /** A throwaway git worktree off `main`, when the handler writes code. */
  worktree?: string;
}

/**
 * A handler is a thin config over `runAgent`: a prompt-shaping `build()` that
 * returns the full agent input minus `surface` (the dispatcher picks the surface
 * from `trigger`). Handlers register themselves into `REGISTRY` at module load.
 */
export interface HandlerDef {
  /** Stable single-letter id, 'A'..'L'. */
  id: string;
  name: string;
  /** `on-demand` runs only when Kevin asks; `autonomous` may run unattended. */
  trigger: 'on-demand' | 'autonomous';
  build(goal: string, ctx: HandlerCtx): Omit<RunAgentInput, 'surface'>;
}

/** Process-wide handler registry, keyed by `HandlerDef.id`. */
export const REGISTRY: Record<string, HandlerDef> = {};

/** Register a handler. A duplicate id overwrites the prior entry. */
export function register(h: HandlerDef): void {
  REGISTRY[h.id] = h;
}
