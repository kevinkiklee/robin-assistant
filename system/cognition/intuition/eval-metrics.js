// eval-metrics.js — pure metric formulas over labelled rows.
//
// Each `labelledRow` is an array of per-hit `{ rank_index, label }` entries
// produced by `labelHits()`.

const LABEL_GAIN = {
  soft_positive: 0.5,
  unlabeled: 0,
  negative: -1,
};

function gainFor(label) {
  const numeric = LABEL_GAIN[label] ?? 0;
  return Math.max(0, 2 ** numeric - 1);
}

function softPositivesInTopK(row, k) {
  let n = 0;
  for (const h of row) {
    if ((h.rank_index ?? 0) < k && h.label === 'soft_positive') n++;
  }
  return n;
}

function softPositivesTotal(row) {
  let n = 0;
  for (const h of row) if (h.label === 'soft_positive') n++;
  return n;
}

/**
 * precision@k averaged over rows.
 * @param {Array<Array<{ rank_index: number, label: string }>>} rows
 * @param {number} k
 * @returns {number}
 */
export function precisionAtK(rows, k) {
  if (!rows.length) return 0;
  let sum = 0;
  for (const row of rows) sum += softPositivesInTopK(row, k) / k;
  return sum / rows.length;
}

/**
 * recall@k averaged over rows. Rows with zero soft_positives contribute 0
 * (do not divide by zero).
 */
export function recallAtK(rows, k) {
  if (!rows.length) return 0;
  let sum = 0;
  for (const row of rows) {
    const total = softPositivesTotal(row);
    if (total === 0) continue;
    sum += softPositivesInTopK(row, k) / total;
  }
  return sum / rows.length;
}

/**
 * nDCG@k with non-negative gain projection: gain = max(0, 2^label - 1).
 * Idealised over the row's own hits.
 */
export function ndcgAtK(rows, k) {
  if (!rows.length) return 0;
  let sumNdcg = 0;
  let counted = 0;
  for (const row of rows) {
    const topK = row.filter((h) => (h.rank_index ?? 0) < k);
    if (topK.length === 0) continue;
    let dcg = 0;
    for (const h of topK) {
      const r = (h.rank_index ?? 0) + 1; // 1-indexed
      dcg += gainFor(h.label) / Math.log2(r + 1);
    }
    const idealGains = row
      .map((h) => gainFor(h.label))
      .sort((a, b) => b - a)
      .slice(0, k);
    let idcg = 0;
    for (let i = 0; i < idealGains.length; i++) {
      idcg += idealGains[i] / Math.log2(i + 2);
    }
    if (idcg <= 0) continue;
    sumNdcg += dcg / idcg;
    counted += 1;
  }
  return counted === 0 ? 0 : sumNdcg / counted;
}

/**
 * Average 1-indexed rank of `negative` hits, averaged across rows that have
 * at least one negative. Returns `null` if no row has any negatives.
 */
export function meanRankOfNegatives(rows) {
  let sumRowMeans = 0;
  let rowsWithNeg = 0;
  for (const row of rows) {
    const negRanks = [];
    for (const h of row) {
      if (h.label === 'negative') negRanks.push((h.rank_index ?? 0) + 1);
    }
    if (negRanks.length === 0) continue;
    let s = 0;
    for (const r of negRanks) s += r;
    sumRowMeans += s / negRanks.length;
    rowsWithNeg += 1;
  }
  return rowsWithNeg === 0 ? null : sumRowMeans / rowsWithNeg;
}

/**
 * no_signal_rate = rows with outcome='evaluated_no_signal' divided by all
 * evaluated rows (`pending` excluded).
 */
export function noSignalRate(rawRows) {
  let evaluated = 0;
  let noSignal = 0;
  for (const r of rawRows) {
    if (r.outcome === 'pending') continue;
    evaluated += 1;
    if (r.outcome === 'evaluated_no_signal') noSignal += 1;
  }
  return evaluated === 0 ? 0 : noSignal / evaluated;
}
