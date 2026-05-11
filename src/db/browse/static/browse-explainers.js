// EXPLAINERS — short, plain-English descriptions of every term-of-art rendered
// in the View section (v2). Hover/focus a labeled element to see the explainer.
// Categories match the data-explain-category attribute used in renderers.

export const EXPLAINERS = {
  'entity-kind': {
    person: 'A person Robin tracks (you, contacts, public figures).',
    project: 'An ongoing initiative or codebase.',
    tool: 'A piece of software, service, or instrument.',
    decision: 'A logged decision treated as an entity for cross-linking.',
    place: 'A physical or virtual location.',
    concept: 'An idea, topic, or category of thought.',
    integration: 'A connected external service or data source.',
    source: 'A feeder pipeline supplying events.',
    event: 'A bounded happening in time (meeting, trip, milestone).',
    task: 'A task tracked as an entity for graph purposes.',
  },
  source: {
    cli: 'Captured via the robin CLI (`robin remember`, etc.).',
    discord: 'Imported from a connected Discord channel.',
    gmail: 'Imported from a Gmail integration sync.',
    spotify: 'Imported from the Spotify integration.',
    google_drive: 'Imported from the Google Drive integration.',
    whoop: 'Imported from the Whoop integration.',
    biographer: 'Written by the biographer pipeline.',
    dream: 'Written by the dream pipeline.',
    inbound: 'Inbound capture from a host (Claude Code, Gemini CLI, …) via the SessionStart hook.',
  },
  'confidence-level': {
    verified: 'Independently confirmed — Robin treats this as ground truth.',
    likely: 'Well supported but not independently confirmed.',
    inferred: 'Derived from multiple signals; no direct statement.',
    guess: "Weakly supported — Robin's best guess.",
  },
  'rule-state': {
    active: "The rule is in effect and shapes Robin's output.",
    deactivated: 'The rule has been retired but is kept for audit.',
  },
  'rule-scope': {
    base: 'The rule applies in all contexts.',
    domain: 'The rule only applies inside a named domain.',
  },
  'candidate-status': {
    pending: 'Dream proposed this rule; the user has not yet decided.',
    approved: 'The user accepted the candidate; it now lives in `rules`.',
    rejected: 'The user rejected the candidate; dream will not re-propose.',
  },
  layer: {
    L1: 'The raw signal layer — atomic events of what Robin observes.',
    L2: 'Threads and episodes — time-bounded containers around events.',
    L3: 'The entity-and-relation graph layer that ties memory together.',
    L4: 'Self-improvement — knowledge, rules, patterns, the user profile.',
    OP: 'Operational plumbing — runtime config, jobs, sessions, migrations.',
  },
  term: {
    thread: "A live host session's running event stream.",
    episode: 'A reflective summary built from a thread or batch of events.',
    knowledge: 'Distilled, durable facts the biographer has promoted out of events.',
    rule: 'An active behavioural directive that shapes how Robin responds.',
    pattern: 'A recurring observation. Strong patterns get proposed as rule candidates.',
    embedding: 'A numeric vector representing meaning — used for similarity recall.',
    biographer: 'The pipeline that promotes events into knowledge, entities, and edges.',
    dream: 'The reflective pipeline that proposes rules and updates patterns.',
    'rolling average': 'A smoothed line averaging the last N buckets.',
    bucket: 'A time bin (day, week, month) that activity is grouped into.',
  },
};

export function explain(category, key) {
  const cat = EXPLAINERS[category];
  if (!cat || typeof key !== 'string') return null;
  if (Object.hasOwn(cat, key)) return cat[key];
  let best = null;
  for (const k of Object.keys(cat)) {
    if (k.endsWith(':') && key.startsWith(k) && (best == null || k.length > best.length)) {
      best = k;
    }
  }
  return best ? cat[best] : null;
}

export function mountTooltipDelegation(rootEl, bubbleEl) {
  if (!rootEl || !bubbleEl) return;
  let showTimer = null;
  let hideTimer = null;

  function contentFor(target) {
    return explain(target.dataset.explainCategory, target.dataset.explainKey);
  }

  function position(target) {
    const r = target.getBoundingClientRect();
    bubbleEl.style.maxWidth = '320px';
    bubbleEl.style.position = 'fixed';
    bubbleEl.style.visibility = 'hidden';
    bubbleEl.style.display = 'block';
    const bw = bubbleEl.offsetWidth;
    const bh = bubbleEl.offsetHeight;
    let top = r.bottom + 6;
    if (top + bh > window.innerHeight - 8) top = r.top - bh - 6;
    let left = r.left;
    if (left + bw > window.innerWidth - 8) left = window.innerWidth - bw - 8;
    if (left < 8) left = 8;
    bubbleEl.style.top = `${top}px`;
    bubbleEl.style.left = `${left}px`;
    bubbleEl.style.visibility = 'visible';
    bubbleEl.setAttribute('aria-hidden', 'false');
  }

  function show(target, immediate = false) {
    const text = contentFor(target);
    if (!text) return;
    clearTimeout(hideTimer);
    if (immediate) {
      bubbleEl.textContent = text;
      position(target);
      return;
    }
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      bubbleEl.textContent = text;
      position(target);
    }, 350);
  }

  function hide() {
    clearTimeout(showTimer);
    hideTimer = setTimeout(() => {
      bubbleEl.style.display = 'none';
      bubbleEl.setAttribute('aria-hidden', 'true');
    }, 200);
  }

  rootEl.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-explain-category][data-explain-key]');
    if (t) show(t);
  });
  rootEl.addEventListener('mouseout', (e) => {
    const t = e.target.closest('[data-explain-category][data-explain-key]');
    if (t) hide();
  });
  rootEl.addEventListener('focusin', (e) => {
    const t = e.target.closest('[data-explain-category][data-explain-key]');
    if (t) show(t, true);
  });
  rootEl.addEventListener('focusout', (e) => {
    const t = e.target.closest('[data-explain-category][data-explain-key]');
    if (t) hide();
  });
  rootEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
}
