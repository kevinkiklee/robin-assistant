---
name: web-research
description: A method for multi-step web research that produces a cross-checked, cited answer instead of a single-search guess. Use for questions needing current, authoritative, or contested information.
metadata:
  version: "1.0"
---

# Web research

Use this when a question needs **current, authoritative, or contested** information — not for things already known or in local context. The goal is a synthesized answer backed by **independent, cited sources**, not the first search result.

## Method

1. **Frame the question.** Write down exactly what's being asked and what a complete answer must include. If it's broad or ambiguous, decompose it into sub-questions and resolve each — don't research a vague blob.

2. **Plan sources before searching.** For each sub-question, note what *kind* of source would actually settle it (primary docs, official changelog, standards body, peer-reviewed work, vendor docs, reputable reporting). Prefer primary sources over aggregators.

3. **Search iteratively.** Start broad to map the landscape, then narrow with specific terms you learned from the first pass. Reformulate when results are thin — try the precise product/version name, error string, or domain term rather than paraphrase.

4. **Read, don't skim-and-assume.** Open the actual source. Distinguish the claim from the source's spin. Note publication dates — stale info is a common trap, especially for fast-moving tools.

5. **Cross-check every load-bearing claim** against at least one *independent* source. Two pages copying the same press release are one source. If sources conflict, surface the conflict and weigh credibility/recency rather than picking silently.

6. **Track provenance as you go.** Keep each fact tied to its URL so the final answer can cite. An uncited claim is a guess.

7. **Synthesize.** Answer the original question directly first, then support it. Separate what's well-established from what's uncertain or contested. State what you could *not* confirm.

## Output

- Lead with the direct answer / recommendation.
- Support each material claim with a citation (plain URL).
- Call out uncertainty, conflicts, and recency explicitly — don't smooth them over.
- If the question couldn't be fully answered, say what's missing and what would resolve it.

## Pitfalls

- Stopping at the first plausible result.
- Treating volume of agreement as truth when it's all one origin.
- Ignoring dates on time-sensitive topics.
- Presenting a confident synthesis that hides a real source conflict.
- Paraphrasing a source's claim as fact without verifying it.
