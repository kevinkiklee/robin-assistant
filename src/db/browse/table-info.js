// Human-readable descriptions of every table in Robin's memory (v2 schema).
//
// Layers — mirrors src/schema/migrations:
//   L1  events             — raw signals (formerly v1 "captures")
//   L2  episodes / threads — time-bounded containers
//   L3  entities & edges   — the knowledge graph
//   L4  reflection         — knowledge, rules, patterns, profile
//   OP  operational        — caches, migrations, runtime state

export const ARCHITECTURE = {
  title: "Robin's memory, in four layers",
  intro:
    'Every interaction Robin has flows through the same pipeline: a raw signal ' +
    'is recorded as an event, grouped into an episode or thread, distilled into ' +
    'entities and the edges between them, and finally promoted into knowledge, ' +
    'rules, and profile fields that change how Robin behaves. Click any table on ' +
    'the left to see what it stores.',
  layers: [
    {
      id: 'L1',
      name: 'Events',
      tables: ['events', 'recall_events'],
      summary:
        'The raw inbox. Every observed signal — a fact you stated, a preference, ' +
        'a correction, an integration update — lands in `events` first with ' +
        'provenance, an embedding, and a back-link to its parent thread.',
    },
    {
      id: 'L2',
      name: 'Episodes & threads',
      tables: ['episodes', 'threads', 'about', 'mentions', 'precedes'],
      summary:
        'Time-bounded containers. Threads group an active conversation; episodes ' +
        'are reflective summaries the biographer produces over a thread or batch ' +
        'of events. Edges `about` / `mentions` link them to entities; `precedes` ' +
        'links event → event for narrative order.',
    },
    {
      id: 'L3',
      name: 'Entities & edges',
      tables: ['entities', 'co_occurs_with', 'participates_in', 'works_on'],
      summary:
        'The graph of things Robin knows: people, projects, tools, decisions, ' +
        'places, concepts. Edges carry provenance and confidence. ' +
        '`participates_in` (membership), `works_on` (activity), and ' +
        '`co_occurs_with` (statistical co-mention) are the structural edges.',
    },
    {
      id: 'L4',
      name: 'Reflection',
      tables: ['knowledge', 'rules', 'rule_candidates', 'patterns', 'profile', 'refusals'],
      summary:
        'What Robin has learned. `knowledge` rows are durable distilled facts. ' +
        '`rules` are active behavioural directives (with `rule_candidates` ' +
        'pending review). `patterns` are recurring observations. `profile` is ' +
        "Robin's structured view of you. `refusals` log times Robin " +
        'declined an action.',
    },
    {
      id: 'OP',
      name: 'Operational',
      tables: [
        '_migrations',
        'runtime',
        'runtime_jobs',
        'runtime_sessions',
        'runtime_introspection_state',
        'runtime_intuition_telemetry',
      ],
      summary:
        'Plumbing. `runtime` holds singleton config rows (embedder profile, ' +
        'scheduler cursor, etc.). `runtime_jobs` schedules background work. ' +
        '`runtime_sessions` tracks live host sessions. `_migrations` records ' +
        'applied schema changes.',
    },
  ],
};

const sample = (label, sql) => ({ label, sql });

export const TABLE_INFO = {
  // ── L1 ───────────────────────────────────────────────────────────
  events: {
    layer: 'L1',
    layerName: 'Events',
    populates_when:
      'Robin observes a signal — you say something, a sync job runs, or another integration emits a record.',
    purpose:
      'The raw input layer. Every fact, preference, decision, correction, or update ' +
      'Robin observes lands here first, with provenance and an embedding.',
    detail:
      'Events carry a free-form `content` body, a `source` string identifying the ' +
      'producer, and an `embedding` vector for semantic recall. `biographed_at` ' +
      'flips to a timestamp once the biographer has promoted the row into ' +
      'knowledge/entities. `thread` back-links to the active conversation.',
    keyFields: [
      ['source', 'integration or surface that produced the row (cli, discord, gmail, …)'],
      ['content', 'the captured text'],
      ['embedding', 'embedding vector for similarity search (HNSW indexed)'],
      ['ts', 'when the event was observed'],
      ['biographed_at', 'set once the biographer has consumed this row'],
      ['thread', 'optional back-link to the parent thread'],
      ['meta', 'free-form metadata payload'],
    ],
    related: ['threads', 'episodes', 'entities', 'knowledge'],
    samples: [
      sample(
        '25 most recent',
        'SELECT id, source, ts, content FROM events ORDER BY ts DESC LIMIT 25;',
      ),
      sample(
        'unbiographed',
        'SELECT id, source, ts, content FROM events WHERE biographed_at IS NONE ORDER BY ts DESC LIMIT 50;',
      ),
      sample(
        'embedding coverage',
        'SELECT count() AS total, count(IF embedding IS NOT NONE THEN 1 END) AS embedded FROM events GROUP ALL;',
      ),
      sample(
        'by source',
        'SELECT source, count() AS n FROM events GROUP BY source ORDER BY n DESC;',
      ),
    ],
  },

  recall_events: {
    layer: 'L1',
    layerName: 'Events',
    populates_when: 'Robin runs a recall query (manual or auto).',
    purpose:
      'Telemetry log of every recall invocation — what was asked, what was retrieved, whether it was used.',
    detail:
      'Each row records the recall query, the candidate set, the rerank scores, and ' +
      'an optional `used_at` set when a downstream tool marks the recall as useful. ' +
      'Drives the intuition feedback loop.',
    keyFields: [
      ['query', 'the recall query string'],
      ['candidates', 'array of event/entity ids considered'],
      ['used_at', 'set when the recall result was used'],
      ['ts', 'when recall ran'],
    ],
    related: ['events', 'entities'],
    samples: [
      sample(
        'recent recalls',
        'SELECT id, ts, query, used_at FROM recall_events ORDER BY ts DESC LIMIT 25;',
      ),
      sample(
        'unused recalls (7d)',
        'SELECT id, ts, query FROM recall_events WHERE used_at IS NONE AND ts >= time::now() - 7d ORDER BY ts DESC LIMIT 50;',
      ),
    ],
  },

  // ── L2 ───────────────────────────────────────────────────────────
  episodes: {
    layer: 'L2',
    layerName: 'Episodes & threads',
    populates_when: 'The biographer synthesises an episode from a thread or a batch of events.',
    purpose: 'Reflective summaries — a distilled narrative built from the underlying events.',
    detail:
      'Episodes carry their own embedding so similar past episodes can be ' +
      'retrieved. They are the unit the dream pipeline reasons over when ' +
      'looking for recurring patterns.',
    keyFields: [
      ['title', 'short human-readable label'],
      ['summary', 'distilled prose summary'],
      ['started_at', 'window start'],
      ['ended_at', 'window end'],
      ['embedding', 'embedding vector for similar-episode lookup'],
    ],
    related: ['events', 'threads', 'entities'],
    samples: [
      sample(
        'most recent',
        'SELECT id, title, started_at, ended_at FROM episodes ORDER BY started_at DESC LIMIT 25;',
      ),
    ],
  },

  threads: {
    layer: 'L2',
    layerName: 'Episodes & threads',
    populates_when: 'A host (Claude Code, Gemini CLI, etc.) opens a new session.',
    purpose:
      'Active conversational containers — one row per live session, holding the running event stream.',
    detail:
      'A thread typically closes when the host disconnects. Threads are the ' +
      'unit the biographer reads when promoting events into episodes/entities.',
    keyFields: [
      ['host', 'host identifier (claude_code, gemini_cli, …)'],
      ['session_id', 'host-supplied session id'],
      ['opened_at', 'when the thread started'],
      ['closed_at', 'when the thread ended (NONE = still open)'],
    ],
    related: ['events', 'episodes'],
    samples: [
      sample(
        'open threads',
        'SELECT id, host, session_id, opened_at FROM threads WHERE closed_at IS NONE ORDER BY opened_at DESC;',
      ),
      sample('by host', 'SELECT host, count() AS n FROM threads GROUP BY host ORDER BY n DESC;'),
    ],
  },

  about: {
    layer: 'L2',
    layerName: 'Episodes & threads',
    purpose: 'Edge: event → entity. Records the entities this event is primarily about.',
    detail:
      'Stronger than `mentions` — the event is centrally about the target entity, ' +
      'not just referencing it.',
    keyFields: [
      ['in', 'event (source)'],
      ['out', 'entity (target)'],
    ],
    related: ['events', 'entities', 'mentions'],
    samples: [
      sample('25 most recent edges', 'SELECT in, out FROM about LIMIT 25;'),
      sample(
        'events about an entity',
        '-- replace ENTITY_ID\nSELECT in.* FROM about WHERE out = entities:ENTITY_ID;',
      ),
    ],
  },

  mentions: {
    layer: 'L2',
    layerName: 'Episodes & threads',
    purpose: 'Edge: event → entity. Records every entity referenced by an event.',
    detail:
      'Mentions are the wider net; `about` is a stricter subset. The recall ' +
      'pipeline uses mentions to find every event that touched a given entity.',
    keyFields: [
      ['in', 'event (source)'],
      ['out', 'entity (target)'],
    ],
    related: ['events', 'entities', 'about'],
    samples: [
      sample('recent mentions', 'SELECT in, out FROM mentions LIMIT 25;'),
      sample(
        'events mentioning an entity',
        '-- replace ENTITY_ID\nSELECT in.* FROM mentions WHERE out = entities:ENTITY_ID;',
      ),
    ],
  },

  precedes: {
    layer: 'L2',
    layerName: 'Episodes & threads',
    purpose: 'Edge: event → event. Narrative ordering edge linking consecutive events.',
    detail:
      'Lets the recall and dream pipelines walk a chain of events in temporal ' +
      'order without re-sorting on `ts`.',
    keyFields: [
      ['in', 'preceding event'],
      ['out', 'following event'],
    ],
    related: ['events'],
    samples: [sample('25 most recent edges', 'SELECT in, out FROM precedes LIMIT 25;')],
  },

  // ── L3 ───────────────────────────────────────────────────────────
  entities: {
    layer: 'L3',
    layerName: 'Entities & edges',
    populates_when:
      'Robin learns about a person, project, tool, place, concept, integration, or event.',
    purpose: 'A node in the knowledge graph.',
    detail:
      'Entities are uniquely keyed by `slug` within a kind. Aliases let alternate ' +
      'names resolve to the same node. BM25 full-text and HNSW vector indexes both ' +
      'apply so recall can match on either signal.',
    keyFields: [
      [
        'kind',
        'person / project / tool / decision / place / concept / integration / source / event / task',
      ],
      ['slug', 'stable URL-safe identifier within a kind'],
      ['name', 'canonical display name'],
      ['aliases', 'alternative names — searched alongside name'],
      ['summary', 'short description (BM25 indexed)'],
      ['embedding', 'embedding vector for semantic search'],
    ],
    related: ['mentions', 'about', 'participates_in', 'works_on', 'co_occurs_with'],
    samples: [
      sample('by name', 'SELECT id, kind, name, slug FROM entities ORDER BY name LIMIT 100;'),
      sample('by kind', 'SELECT kind, count() AS n FROM entities GROUP BY kind ORDER BY n DESC;'),
      sample(
        'with alias',
        'SELECT id, kind, name, aliases FROM entities WHERE array::len(aliases) > 0 LIMIT 50;',
      ),
    ],
  },

  co_occurs_with: {
    layer: 'L3',
    layerName: 'Entities & edges',
    purpose: 'Edge: entity ↔ entity. Statistical co-mention edge.',
    detail:
      'Updated by the dream pipeline when two entities show up together often ' +
      'enough to suggest a relationship the schema cannot capture directly.',
    keyFields: [
      ['in', 'entity A'],
      ['out', 'entity B'],
      ['weight', 'how often they co-occur'],
    ],
    related: ['entities'],
    samples: [
      sample(
        'strongest links',
        'SELECT in, out, weight FROM co_occurs_with ORDER BY weight DESC LIMIT 25;',
      ),
    ],
  },

  participates_in: {
    layer: 'L3',
    layerName: 'Entities & edges',
    purpose: 'Edge: entity → entity. Membership/participation edge (person → project, etc.).',
    keyFields: [
      ['in', 'member entity'],
      ['out', 'group / project / event entity'],
    ],
    related: ['entities'],
    samples: [sample('25 most recent', 'SELECT in, out FROM participates_in LIMIT 25;')],
  },

  works_on: {
    layer: 'L3',
    layerName: 'Entities & edges',
    purpose: 'Edge: entity → entity. Activity edge — actor works on a project/tool/task.',
    keyFields: [
      ['in', 'actor entity'],
      ['out', 'target entity'],
    ],
    related: ['entities', 'participates_in'],
    samples: [sample('25 most recent', 'SELECT in, out FROM works_on LIMIT 25;')],
  },

  // ── L4 ───────────────────────────────────────────────────────────
  knowledge: {
    layer: 'L4',
    layerName: 'Self-improvement',
    populates_when: 'The biographer promotes a recurring or strongly supported fact out of events.',
    purpose: 'Durable distilled facts — what Robin treats as true.',
    detail:
      'Each row links back to the supporting events so the evidence trail stays ' +
      'intact. Knowledge can be revised; older rows are retained for audit.',
    keyFields: [
      ['content', 'the fact, in prose'],
      ['topic', 'short topic slug for grouping'],
      ['evidence', 'array of supporting event ids'],
      ['confidence', 'verified / likely / inferred / guess'],
      ['embedding', 'vector for semantic recall'],
    ],
    related: ['events', 'entities', 'rules'],
    samples: [
      sample(
        'by topic',
        'SELECT topic, count() AS n FROM knowledge GROUP BY topic ORDER BY n DESC;',
      ),
      sample(
        'most recent',
        'SELECT id, topic, content, created FROM knowledge ORDER BY created DESC LIMIT 25;',
      ),
    ],
  },

  rules: {
    layer: 'L4',
    layerName: 'Self-improvement',
    populates_when:
      'A `rule_candidate` is approved (via `robin rules approve`) and promoted to an active rule.',
    purpose: 'Active behavioural directives Robin reads at session start.',
    detail:
      "Active rules shape Robin's output. Deactivating a rule keeps the row for " +
      'audit; `state` flips from active to deactivated rather than deleting.',
    keyFields: [
      ['state', 'active / deactivated'],
      ['scope', 'base (always) or domain (scoped)'],
      ['directive', 'the actual instruction Robin will follow'],
      ['source_candidate', 'the rule_candidate row that produced this rule'],
    ],
    related: ['rule_candidates', 'knowledge'],
    samples: [
      sample('active rules', "SELECT id, scope, directive FROM rules WHERE state = 'active';"),
      sample('by scope', 'SELECT scope, count() AS n FROM rules GROUP BY scope ORDER BY n DESC;'),
    ],
  },

  rule_candidates: {
    layer: 'L4',
    layerName: 'Self-improvement',
    populates_when: 'Dream proposes a candidate rule from observed patterns.',
    purpose: 'Pending behavioural directives awaiting user review.',
    detail:
      'Dream writes candidates with enough rationale that the user can decide ' +
      'whether to approve or reject. Approved candidates become `rules`; rejected ' +
      'ones are retained so dream does not re-propose them.',
    keyFields: [
      ['status', 'pending / approved / rejected'],
      ['directive', 'proposed instruction'],
      ['rationale', 'why dream thinks this is a rule'],
      ['evidence', 'supporting events/episodes'],
    ],
    related: ['rules'],
    samples: [
      sample(
        'pending',
        "SELECT id, directive, rationale, created FROM rule_candidates WHERE status = 'pending' ORDER BY created DESC;",
      ),
      sample('by status', 'SELECT status, count() AS n FROM rule_candidates GROUP BY status;'),
    ],
  },

  patterns: {
    layer: 'L4',
    layerName: 'Self-improvement',
    populates_when: 'Dream detects a recurring observation worth tracking.',
    purpose: 'Recurring observations — softer than knowledge, harder than a one-off.',
    detail:
      'Patterns are the precursors to rules. Each row carries a signal count and ' +
      'the events that support it. Once support is strong enough, dream may ' +
      'propose a corresponding rule_candidate.',
    keyFields: [
      ['pattern', 'short description of the observation'],
      ['signal_count', 'how many independent supports'],
      ['domain', 'optional scope'],
    ],
    related: ['rule_candidates', 'knowledge'],
    samples: [
      sample(
        'strongest',
        'SELECT id, pattern, signal_count FROM patterns ORDER BY signal_count DESC LIMIT 25;',
      ),
    ],
  },

  profile: {
    layer: 'L4',
    layerName: 'Self-improvement',
    populates_when:
      "Biographer or dream updates Robin's structured view of you (name, focus, working hours, etc.).",
    purpose: "Robin's structured profile of the user — name, focus, working style, preferences.",
    detail:
      'Singleton-ish: typically one main `profile:me` row plus optional per-domain ' +
      'overlays. Distinct from `knowledge` in that profile fields are explicitly ' +
      'about *you*, not the world.',
    keyFields: [
      ['name', 'canonical display name'],
      ['focus', 'current primary focus / project'],
      ['working_style', 'how the user prefers to work'],
      ['updated', 'last refresh'],
    ],
    related: ['knowledge', 'rules'],
    samples: [sample('all', 'SELECT * FROM profile;')],
  },

  refusals: {
    layer: 'L4',
    layerName: 'Self-improvement',
    populates_when: 'Robin declines to perform an outbound action.',
    purpose: 'Audit log of refusals — when and why Robin said no.',
    detail:
      'Captures the surface, action, rationale, and reviewer disposition. Lets ' +
      "you tune Robin's refusal policy by reviewing what it has blocked.",
    keyFields: [
      ['surface', 'which integration / tool the refusal came from'],
      ['action', 'the proposed action'],
      ['reason', 'why Robin refused'],
      ['ts', 'when the refusal happened'],
    ],
    related: ['rules'],
    samples: [
      sample(
        'recent refusals',
        'SELECT id, ts, surface, action, reason FROM refusals ORDER BY ts DESC LIMIT 25;',
      ),
      sample(
        'by surface',
        'SELECT surface, count() AS n FROM refusals GROUP BY surface ORDER BY n DESC;',
      ),
    ],
  },

  // ── OP ───────────────────────────────────────────────────────────
  runtime: {
    layer: 'OP',
    layerName: 'Operational',
    purpose: 'Singleton runtime config rows — embedder profile, scheduler cursor, etc.',
    detail:
      'Each row is a key/value pair under a stable record id (e.g. ' +
      '`runtime:embedder`, `runtime:scheduler`). Reading these tells you what the ' +
      'daemon is currently configured with.',
    keyFields: [
      ['id', 'singleton key (embedder / scheduler / …)'],
      ['value', 'JSON-shaped configuration payload'],
    ],
    related: ['runtime_jobs', 'runtime_sessions'],
    samples: [sample('all', 'SELECT * FROM runtime;')],
  },

  runtime_jobs: {
    layer: 'OP',
    layerName: 'Operational',
    purpose: 'Scheduled background work — drop-in jobs the scheduler runs.',
    detail:
      'One row per job. `next_run_at` is updated by the scheduler each time the ' +
      'job fires; `in_flight` guards against double-firing.',
    keyFields: [
      ['name', 'job slug'],
      ['next_run_at', 'when this job is next due'],
      ['in_flight', 'true while a run is executing'],
      ['last_run_at', 'when the job last ran'],
    ],
    related: ['runtime'],
    samples: [
      sample(
        'upcoming',
        'SELECT name, next_run_at, last_run_at FROM runtime_jobs ORDER BY next_run_at;',
      ),
    ],
  },

  runtime_sessions: {
    layer: 'OP',
    layerName: 'Operational',
    purpose: 'Live host sessions — one row per connected host (Claude Code, Gemini CLI, …).',
    detail:
      'A session sweeper marks sessions stale after 5 minutes of silence; ' +
      'sessions are purged manually with `robin sessions purge`.',
    keyFields: [
      ['session_id', 'host-supplied id'],
      ['host', 'host identifier'],
      ['pid', 'host process id'],
      ['last_seen_at', 'last heartbeat'],
      ['state', 'active / stale'],
    ],
    related: ['threads'],
    samples: [
      sample(
        'active',
        "SELECT session_id, host, last_seen_at FROM runtime_sessions WHERE state = 'active';",
      ),
    ],
  },

  runtime_introspection_state: {
    layer: 'OP',
    layerName: 'Operational',
    purpose: "Cached findings from the daemon's boot-time introspection.",
    detail:
      'SessionStart hook reads this to surface introspection warnings to the user ' +
      'without recomputing on every connect.',
    keyFields: [
      ['ok', 'true if no findings'],
      ['findings', 'array of {kind, path, detail}'],
      ['checked_at', 'when the check ran'],
    ],
    related: [],
    samples: [
      sample('current', "SELECT * FROM type::record('runtime_introspection_state', 'current');"),
    ],
  },

  runtime_intuition_telemetry: {
    layer: 'OP',
    layerName: 'Operational',
    purpose: 'Telemetry rollup for the intuition feature.',
    detail:
      'Aggregated counters describing how often intuition fired, what fraction ' +
      'of recalls were used, and which queries dominated. Drives tuning of the ' +
      'intuition heuristic.',
    keyFields: [
      ['period', 'bucket label (day / week)'],
      ['fired', 'count of recalls invoked'],
      ['used', 'count of recalls marked useful'],
    ],
    related: ['recall_events'],
    samples: [
      sample('all', 'SELECT * FROM runtime_intuition_telemetry ORDER BY period DESC LIMIT 30;'),
    ],
  },

  _migrations: {
    layer: 'OP',
    layerName: 'Operational',
    purpose: 'Append-only log of every applied schema migration.',
    detail:
      'Each row records the migration number, name, content hash, and timestamp. ' +
      '`robin migrate` skips rows already present here.',
    keyFields: [
      ['number', 'monotonically increasing migration index'],
      ['name', 'migration script name'],
      ['file_hash', 'sha256 of the migration file at apply time'],
      ['applied_at', 'when the migration ran'],
    ],
    related: [],
    samples: [
      sample('history', 'SELECT number, name, applied_at FROM _migrations ORDER BY number DESC;'),
    ],
  },
};

// Brief one-liner per table for sidebar tooltips and quick context.
export function shortDescription(name) {
  return TABLE_INFO[name]?.purpose ?? null;
}
