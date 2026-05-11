// Thin View page dispatcher. Each page module exports `activate(host)`.

const PAGE_LOADERS = {
  dashboard: () => import('/db/static/browse-view-dashboard.js'),
  analysis: () => import('/db/static/browse-view-analysis.js'),
  trends: () => import('/db/static/browse-view-trends.js'),
  inventory: () => import('/db/static/browse-view-inventory.js'),
  entity: () => import('/db/static/browse-view-profile.js'),
};

export async function activate(host, page = 'dashboard') {
  const loader = PAGE_LOADERS[page] ?? PAGE_LOADERS.dashboard;
  host.innerHTML = '<p style="padding:1rem;color:#888">Loading…</p>';
  const mod = await loader();
  await mod.activate(host);
}
