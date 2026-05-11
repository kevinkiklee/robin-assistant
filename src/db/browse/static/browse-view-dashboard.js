// Dashboard page renderer (v2 schema).
// Layout: greeting → at-a-glance tiles → about you → recently active grid →
// recent activity TABLE (paginated) → needs-your-input.
import { formatTimeAgo } from '/db/static/browse-cards.js';

const PAGE_SIZE = 12;
let cachedActivity = [];
let activityPage = 0;

export async function activate(host) {
  host.innerHTML = renderShell('<div class="page-body">Loading dashboard…</div>');
  let data;
  try {
    data = await fetch('/db/api/view/dashboard').then((r) => r.json());
  } catch (err) {
    host.innerHTML = renderShell(
      `<div class="page-body empty">Could not load dashboard: ${escapeHtml(String(err))}</div>`,
    );
    return;
  }
  cachedActivity = data.recent_activity || [];
  activityPage = 0;
  host.innerHTML = render(data);
  requestAnimationFrame(() => {
    host.querySelectorAll('.fade-in').forEach((el, i) => {
      el.style.animationDelay = `${i * 30}ms`;
      el.classList.add('fade-in--ready');
    });
  });
  attachInteractions(host, data);
}

function renderShell(content) {
  return `
    <div class="eyebrow"><span>view</span><span class="sep">·</span><span>dashboard</span></div>
    <div class="head"><h1>dashboard</h1></div>
    <div class="purpose">A snapshot of what Robin currently knows about you and what is fresh.</div>
    ${content}`;
}

function render(d) {
  const lastCap = d.last_capture_ts
    ? `last event ${formatTimeAgo(d.last_capture_ts)}`
    : 'no events yet';
  return `
    <div class="eyebrow"><span>view</span><span class="sep">·</span><span>dashboard</span></div>
    <div class="head"><h1>${d.user ? `hi, ${escapeHtml(d.user.name.toLowerCase())}` : 'welcome'}</h1></div>
    <div class="dash-greet fade-in">
      <div class="freshness">${escapeHtml(lastCap)}</div>
      <div class="dash-search-wrap">
        <input class="dash-search" type="search" placeholder="Search entities…" aria-label="search entities" autocomplete="off">
        <div class="search-results" hidden></div>
      </div>
    </div>

    <section class="fade-in">
      <h2 class="page-h">at a glance</h2>
      ${renderCounts(d.counts)}
    </section>

    <section class="fade-in">
      <h2 class="page-h">about you</h2>
      ${renderAboutYou(d.user)}
    </section>

    <section class="fade-in">
      <h2 class="page-h">recently active</h2>
      ${renderRecentlyActive(d.recently_active)}
    </section>

    <section class="fade-in">
      <h2 class="page-h">recent activity</h2>
      ${renderActivityTable(cachedActivity, activityPage)}
    </section>

    ${renderNeedsInput(d.needs_input)}`;
}

function renderAboutYou(user) {
  if (!user) {
    return `<div class="page-body empty">Robin hasn't learned anything about you yet — capture a fact via <code>robin remember</code>.</div>`;
  }
  const summary = user.summary
    ? `<div class="page-body profile-summary">${escapeHtml(user.summary.slice(0, 320))}${user.summary.length > 320 ? '…' : ''}</div>`
    : '';
  return `
    <div class="about-row">
      <div class="about-name"><strong>${escapeHtml(user.name)}</strong></div>
      <div class="chips-row">
        <a class="chip" href="?tab=view&amp;page=entity&amp;entity=${encodeURIComponent(user.slug)}">${user.facts_count ?? 0} events</a>
        <a class="chip" href="?tab=workbench&amp;table=knowledge">${user.knowledge_count ?? 0} knowledge</a>
        <a class="chip" href="?tab=workbench&amp;table=rules">${user.active_rules_count ?? 0} active rules</a>
        <a class="chip" href="?tab=workbench&amp;table=rule_candidates">${user.pending_candidates_count ?? 0} pending</a>
      </div>
    </div>
    ${summary}`;
}

function renderRecentlyActive(items) {
  if (!items?.length) return '<p class="empty">No recent activity in the last 14 days.</p>';
  return `<div class="ra-grid">${items.slice(0, 12).map(renderEntityCard).join('')}</div>`;
}

function renderEntityCard(e) {
  return `<a class="ra-card" href="?tab=view&amp;page=entity&amp;entity=${encodeURIComponent(e.slug)}">
    <div class="ra-card-head">
      <strong>${escapeHtml(e.name)}</strong>
      <span class="badge kind" data-explain-category="entity-kind" data-explain-key="${escapeHtml(e.kind || '')}" tabindex="0">${escapeHtml(e.kind || '')}</span>
    </div>
    <div class="ra-card-meta">${escapeHtml(formatTimeAgo(e.last_activity_ts))}</div>
  </a>`;
}

function renderActivityTable(rows, page) {
  if (!rows?.length) return '<p class="empty">No activity captured yet.</p>';
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);
  const tbody = slice
    .map((row) => {
      const source = row.source || 'unknown';
      const body = String(row.content ?? '').slice(0, 200);
      return `<tr>
      <td class="ar-ts">${escapeHtml(formatTimeAgo(row.ts))}</td>
      <td><span class="badge source" data-explain-category="source" data-explain-key="${escapeHtml(source)}" tabindex="0">${escapeHtml(source)}</span></td>
      <td class="ar-body">${escapeHtml(body)}</td>
    </tr>`;
    })
    .join('');
  return `
    <table class="activity-table">
      <thead><tr><th>when</th><th>source</th><th>content</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <div class="pager" data-total="${rows.length}">
      <button type="button" class="pg-prev" ${page === 0 ? 'disabled' : ''}>‹ prev</button>
      <span class="pg-info">page <strong>${page + 1}</strong> of ${pageCount} · ${rows.length} total</span>
      <button type="button" class="pg-next" ${page >= pageCount - 1 ? 'disabled' : ''}>next ›</button>
    </div>`;
}

function renderNeedsInput(ni) {
  const parts = [];
  if (ni?.pending_rules?.length) {
    parts.push(`<section class="fade-in"><h2 class="page-h">pending rule candidates</h2>
      <ul class="page-list">${ni.pending_rules.map((r) => `<li><strong>${escapeHtml(r.directive ?? '')}</strong>${r.rationale ? ` — ${escapeHtml(r.rationale)}` : ''}</li>`).join('')}</ul></section>`);
  }
  if (ni?.recent_refusals?.length) {
    parts.push(`<section class="fade-in"><h2 class="page-h">recent refusals</h2>
      <ul class="page-list">${ni.recent_refusals.map((c) => `<li><strong>${escapeHtml(c.surface ?? '')}: ${escapeHtml(c.action ?? '')}</strong> — ${escapeHtml(c.reason ?? '')}</li>`).join('')}</ul></section>`);
  }
  return parts.join('');
}

function renderCounts(counts) {
  if (!counts) return '';
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const PRIMARY = 8;
  const headline = entries.slice(0, PRIMARY);
  return `<ul class="tiles">${headline.map(([t, n]) => `<li><a href="?tab=workbench&amp;table=${encodeURIComponent(t)}"><strong>${n.toLocaleString()}</strong><span>${escapeHtml(t)}</span></a></li>`).join('')}</ul>`;
}

function attachInteractions(host, _data) {
  const search = host.querySelector('.dash-search');
  const results = host.querySelector('.search-results');
  let abortCtl = null;
  let debounceTimer = null;
  if (search && results) {
    search.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        abortCtl?.abort();
        abortCtl = new AbortController();
        const q = search.value.trim();
        if (!q) {
          results.hidden = true;
          results.innerHTML = '';
          return;
        }
        try {
          const r = await fetch(`/db/api/view/search?q=${encodeURIComponent(q)}`, {
            signal: abortCtl.signal,
          }).then((x) => x.json());
          results.innerHTML =
            (r.results || [])
              .map(
                (e) =>
                  `<a href="?tab=view&amp;page=entity&amp;entity=${encodeURIComponent(e.slug)}">${escapeHtml(e.name)} <small style="color:var(--fg-3)">${escapeHtml(e.kind || '')}</small></a>`,
              )
              .join('') ||
            '<em style="display:block;padding:6px 10px;color:var(--fg-3)">no matches</em>';
          results.hidden = false;
        } catch (err) {
          if (err?.name !== 'AbortError') console.error('search failed', err);
        }
      }, 200);
    });
    document.addEventListener('click', (e) => {
      if (!results.contains(e.target) && e.target !== search) {
        results.hidden = true;
      }
    });
  }

  host.addEventListener('click', (e) => {
    const prev = e.target.closest('.pg-prev');
    const next = e.target.closest('.pg-next');
    if (!prev && !next) return;
    e.preventDefault();
    const pageCount = Math.max(1, Math.ceil(cachedActivity.length / PAGE_SIZE));
    if (next && activityPage < pageCount - 1) activityPage++;
    if (prev && activityPage > 0) activityPage--;
    const section =
      host.querySelector('section:has(.activity-table)') ||
      host.querySelector('section:has(.empty)');
    if (section) {
      const headHtml = '<h2 class="page-h">recent activity</h2>';
      section.innerHTML = headHtml + renderActivityTable(cachedActivity, activityPage);
    }
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}
