// Format helper for list_journal / list_episodes / list_arcs results.
// Standardizes: sorted most-recent-first, consistent shape.

const DEFAULT_LIMIT = 50;

export function formatJournal(rows, { limit = DEFAULT_LIMIT, full = false } = {}) {
  const sorted = [...rows].sort((a, b) => {
    const ta = new Date(a?.ts ?? a?.created_at ?? 0).getTime();
    const tb = new Date(b?.ts ?? b?.created_at ?? 0).getTime();
    return tb - ta;
  });
  const items = full ? sorted : sorted.slice(0, limit);
  return {
    items,
    meta: {
      total: rows.length,
      shown: items.length,
      trimmed: !full && rows.length > limit,
    },
  };
}
