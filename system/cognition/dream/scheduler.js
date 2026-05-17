// scheduler.js — layered DAG runner for the dream pipeline. Spec §2.
//
// Each topological layer runs its steps concurrently via Promise.all;
// subsequent layers start only after the previous layer settles.
// Per-step errors are captured into the returned summary; they do not
// propagate. The shouldHalt callback is consulted between layers (not
// per-step) — see spec §5.2.

/**
 * @param {Record<string, (ctx: any) => Promise<any>>} steps
 * @param {Record<string, string[]>} deps
 * @param {{
 *   ctx?: any,
 *   maxConcurrent?: number,
 *   onStepSettled?: (name: string, ms: number, err: Error | null, result?: any) => void,
 *   shouldHalt?: () => Promise<boolean>,
 * }} [opts]
 * @returns {Promise<{
 *   summary: Record<string, any>,
 *   layers: { names: string[], started_at: number, ended_at: number, duration_ms: number }[],
 *   halted: 'budget_exhausted' | null,
 * }>}
 */
export async function runDag(steps, deps, opts = {}) {
  const layers = topoLayers(steps, deps);
  const summary = {};
  const layerLog = [];
  let halted = null;

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (opts.shouldHalt && (await opts.shouldHalt())) {
      halted = 'budget_exhausted';
      for (let j = i; j < layers.length; j++) {
        for (const name of layers[j]) {
          if (!(name in summary)) summary[name] = { skipped: 'budget_exhausted' };
        }
      }
      break;
    }
    const t0 = Date.now();
    const slots = chunkByLimit(layer, opts.maxConcurrent ?? Infinity);
    for (const slot of slots) {
      await Promise.all(
        slot.map(async (name) => {
          const stepT0 = Date.now();
          const fn = steps[name];
          if (typeof fn !== 'function') {
            // §10.1 #11 / §7 failure-mode 1: a name in deps without a registry entry.
            // Capture rather than throw so the layer doesn't poison its siblings.
            summary[name] = { error: `step '${name}' has no registered function` };
            return;
          }
          try {
            const result = await fn(opts.ctx);
            summary[name] = result;
            opts.onStepSettled?.(name, Date.now() - stepT0, null, result);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            summary[name] = { error: msg };
            opts.onStepSettled?.(name, Date.now() - stepT0, e);
          }
        }),
      );
    }
    const t1 = Date.now();
    layerLog.push({ names: [...layer], started_at: t0, ended_at: t1, duration_ms: t1 - t0 });
  }

  // Deterministic key insertion order: layer index then lexical within layer.
  const orderedSummary = {};
  for (const layerNames of layers) {
    for (const name of [...layerNames].sort()) {
      if (name in summary) orderedSummary[name] = summary[name];
    }
  }

  return { summary: orderedSummary, layers: layerLog, halted };
}

/**
 * Kahn's algorithm with layer grouping. Throws on cycle.
 *
 * @param {Record<string, any>} steps
 * @param {Record<string, string[]>} deps
 * @returns {string[][]}
 */
export function topoLayers(steps, deps) {
  const names = new Set([...Object.keys(steps), ...Object.keys(deps)]);
  const remaining = new Map();
  for (const n of names) {
    remaining.set(n, new Set(deps[n] ?? []));
  }
  const layers = [];
  while (remaining.size > 0) {
    const ready = [];
    for (const [name, set] of remaining) {
      if (set.size === 0) ready.push(name);
    }
    if (ready.length === 0) {
      throw new Error(`Cycle in DAG: ${[...remaining.keys()].join(', ')}`);
    }
    ready.sort(); // stable layer order
    layers.push(ready);
    for (const r of ready) remaining.delete(r);
    for (const set of remaining.values()) {
      for (const r of ready) set.delete(r);
    }
  }
  return layers;
}

/**
 * Split `arr` into consecutive sub-arrays of length ≤ `limit`. Default
 * unlimited (returns one chunk containing the full array).
 */
function chunkByLimit(arr, limit) {
  if (!limit || limit === Infinity || limit >= arr.length) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += limit) out.push(arr.slice(i, i + limit));
  return out;
}
