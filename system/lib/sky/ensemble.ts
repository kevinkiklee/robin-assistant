/**
 * Ensemble weather model disagreement → confidence factor.
 * High spread across members ⇒ low agreement ⇒ lower confidence.
 * Pure, deterministic module.
 */

export const SPREAD_FULL = 35;

/**
 * Compute agreement factor (0..1) from ensemble member values.
 * Fewer than 2 members ⇒ 1 (no disagreement signal).
 * Otherwise: agreement = clamp(1 - stdev / SPREAD_FULL, 0, 1).
 *
 * @param members - per-member values (typically 0..100 for % coverage), one value per ensemble member
 * @returns agreement factor, 0 (wildly disagreed) to 1 (perfect agreement)
 */
export function agreementFactor(members: number[]): number {
  // Fewer than 2 members: no disagreement signal, don't penalize
  if (members.length < 2) return 1;

  // Compute mean
  const mean = members.reduce((a, b) => a + b, 0) / members.length;

  // Compute population standard deviation
  const sumSquaredDeviations = members.reduce(
    (acc, val) => acc + (val - mean) ** 2,
    0
  );
  const variance = sumSquaredDeviations / members.length;
  const stdev = Math.sqrt(variance);

  // Map stdev to agreement: 0 stdev → 1 agreement, SPREAD_FULL stdev → 0 agreement
  const rawAgreement = 1 - stdev / SPREAD_FULL;

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, rawAgreement));
}
