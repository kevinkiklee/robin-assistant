import { validateRecallTopics } from '../../../lib/recall-topics.ts';
import type { Invariant } from '../types.ts';

/**
 * Auto-recall's reliable layer maps keyword topics → canonical docs in
 * `user-data/config/recall-topics.yaml`. If a mapped doc path is renamed,
 * deleted, or typo'd, a matched topic silently injects nothing — the failure is
 * invisible until you notice Robin "forgot" something it should always surface.
 * This check surfaces broken mappings at `robin doctor` time. `warning` severity:
 * recall still degrades gracefully (other docs + snippets stand), it's just less
 * complete. No `repair` — fixing a path needs human judgement.
 */
export function recallTopicsResolvableInvariant(opts: { userData: string }): Invariant {
  return {
    name: 'recall.topics_resolvable',
    severity: 'warning',
    symptom:
      'Auto-recall references canonical docs that are missing, so a matched topic injects nothing.',
    cause:
      'A docs path in config/recall-topics.yaml points to a content file that was renamed, deleted, or mistyped.',
    fix: 'Correct the path in config/recall-topics.yaml (or restore the doc), then re-run `robin doctor`.',
    check: () => {
      const { missingDocs, oversizedDocs } = validateRecallTopics(opts.userData);
      if (missingDocs.length === 0 && oversizedDocs.length === 0) return { ok: true };
      const parts: string[] = [];
      if (missingDocs.length > 0) {
        parts.push(`${missingDocs.length} missing doc(s): ${missingDocs.join(', ')}`);
      }
      if (oversizedDocs.length > 0) {
        const list = oversizedDocs
          .map((d) => `${d.doc} (${Math.round(d.chars / 1000)}k)`)
          .join(', ');
        parts.push(`${oversizedDocs.length} oversized doc(s) injected whole every turn: ${list}`);
      }
      return {
        ok: false,
        message: `recall-topics: ${parts.join('; ')}`,
        remediation: 'fix paths or split oversized docs in config/recall-topics.yaml',
      };
    },
  };
}
