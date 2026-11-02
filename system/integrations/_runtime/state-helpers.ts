import type { IntegrationContext } from './types.ts';

/**
 * Read a JSON-array value out of the per-integration KV state, returning `[]`
 * on missing, malformed, or non-array values.
 *
 * Every integration that tracks "ids I've already seen this cycle" stores it
 * as `JSON.stringify(string[])` in `integration_state`. The parsing dance is
 * identical at every call site: read the raw string, try JSON.parse, swallow
 * corruption with a warn log, fall back to empty. Keeping that one helper
 * here means a malformed value never wedges a tick (callers always get an
 * iterable) and any future hardening — schema validation, size caps, version
 * tagging — lands once for every integration.
 */
export function readJsonArrayState<T = unknown>(ctx: IntegrationContext, key: string): T[] {
  const raw = ctx.state.get(key);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.log.warn({ key }, 'corrupt dedup state; resetting to empty');
    return [];
  }
  if (!Array.isArray(parsed)) {
    ctx.log.warn({ key, actual: typeof parsed }, 'dedup state was not an array; resetting');
    return [];
  }
  return parsed as T[];
}
