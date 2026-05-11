// Catalog of built-in saved queries shown in the sidebar (v2 schema).
// Pure data — no DOM, no network, no Node-only APIs.

export const SAVED = [
  {
    group: 'schema',
    items: [
      {
        kind: 'page',
        label: 'overview',
        description: "How Robin's data storage layer works — start here.",
        sections: [
          {
            heading: 'One database, four jobs',
            body:
              'Robin runs on SurrealDB, a multi-model database that handles documents, graph ' +
              'edges, vectors, and full-text search in one engine and one query language. That ' +
              "matters because Robin's memory needs all four at once: a single transaction can " +
              'record an event, link it to an entity, update an embedding, and write the ' +
              'narrative edge in one shot. No cross-store synchronisation to manage.',
          },
          {
            heading: 'The four memory layers',
            body:
              'The most important picture in Robin. Raw signals enter at the bottom; each layer ' +
              'above adds structure without throwing the layer below away. Reading top-to-bottom ' +
              'follows the data as it gets distilled — every promotion is reversible because the ' +
              'evidence trail stays intact.',
            diagram: 'layers',
            layers: [
              {
                id: 'L1',
                name: 'Events',
                summary:
                  'Raw signals as they arrive — every fact, preference, decision, correction, task, or update you or an integration emits. Free-form `meta` so any source can attach whatever it has.',
                tables: ['events', 'recall_events'],
                transition: 'grouped into',
              },
              {
                id: 'L2',
                name: 'Episodes & threads',
                summary:
                  "Threads keep a live conversation's event stream together; episodes are the reflective summaries the biographer produces from a thread or batch.",
                tables: ['threads', 'episodes', 'about', 'mentions', 'precedes'],
                transition: 'distilled into',
              },
              {
                id: 'L3',
                name: 'Entities & edges',
                summary:
                  'The knowledge graph: people, projects, tools, decisions, places, concepts. Edges record participation, activity, and statistical co-occurrence.',
                tables: ['entities', 'participates_in', 'works_on', 'co_occurs_with'],
                transition: 'promoted to',
              },
              {
                id: 'L4',
                name: 'Self-improvement',
                summary:
                  "What Robin has learned: durable knowledge, behavioural rules (with pending candidates), recurring patterns, the user's profile, and the refusal audit log. This is the layer that actually changes Robin's behaviour next time.",
                tables: [
                  'knowledge',
                  'rules',
                  'rule_candidates',
                  'patterns',
                  'profile',
                  'refusals',
                ],
                transition: null,
              },
            ],
          },
          {
            heading: 'How writes happen',
            body:
              'The daemon owns the only writable handle to the embedded RocksDB instance. ' +
              'Capture is funnelled through `src/capture/record-event.js` (events) and the ' +
              'biographer (knowledge / entities / edges). Dream proposes rule candidates from ' +
              'recurring patterns; the user approves them via `robin rules approve`.',
          },
          {
            heading: 'How reads happen',
            body:
              '`recall.js` is the free-form question path — embedding-based retrieval over ' +
              'events and entities. The MCP server exposes typed read tools (get-entity, ' +
              'list-episodes, list-rules, …) that hosts call. This browser hits ' +
              'the same daemon process and shares the same dbHandle.',
          },
          {
            heading: 'Migrations and recovery',
            body:
              'Numbered migrations live in `src/schema/migrations`. The applied set is recorded ' +
              'in `_migrations`. Schema is RocksDB-backed and persists across daemon restarts; ' +
              'tests use an in-memory engine for isolation.',
            chips: ['_migrations'],
          },
          {
            heading: 'Where to go next',
            body:
              'Pick a table on the left. Each opens a page that explains what it stores, lists ' +
              "its key fields, and gives you starter queries. The 'about' button (top of the " +
              'sidebar) opens the layer-by-layer architecture overview.',
            chips: ['events', 'entities', 'knowledge', 'rules', '_migrations'],
          },
        ],
      },
      {
        label: 'db info',
        sql: 'INFO FOR DB;',
        description:
          "Surreal's INFO FOR DB query — every table, field definition, index, analyzer, and event in one tree. The fastest way to see what the live schema actually looks like.",
        tables: [],
      },
      {
        label: 'migrations',
        sql: 'SELECT number, name, applied_at FROM _migrations ORDER BY number DESC;',
        description:
          'The append-only migration log — most recent first. If a deploy seems off, check that the latest expected migration number is here.',
        tables: ['_migrations'],
      },
    ],
  },
  {
    group: 'events',
    items: [
      {
        label: 'recent',
        sql: 'SELECT id, source, ts, content, biographed_at FROM events ORDER BY ts DESC LIMIT 25;',
        description:
          'The 25 most recent events across all sources. biographed_at = NONE means the biographer has not yet promoted them to L3/L4.',
        tables: ['events'],
      },
      {
        label: 'unbiographed',
        sql: 'SELECT id, source, ts, content FROM events WHERE biographed_at IS NONE ORDER BY ts DESC LIMIT 50;',
        description:
          'Events sitting in the queue, waiting for the biographer. A persistently long list usually means a biographer run is overdue.',
        tables: ['events'],
      },
      {
        label: 'embedding coverage',
        sql: 'SELECT count() AS n_total, count(IF embedding IS NOT NONE THEN 1 END) AS n_embedded FROM events GROUP ALL;',
        description:
          'Quick health check on the embedder: total events vs. those that have an embedding. A growing gap means embeddings are falling behind.',
        tables: ['events'],
      },
    ],
  },
  {
    group: 'episodes',
    items: [
      {
        label: 'recent',
        sql: 'SELECT id, title, started_at, ended_at FROM episodes ORDER BY started_at DESC LIMIT 25;',
        description:
          'Last 25 episodes with their time windows. ended_at = NONE means the episode is still open.',
        tables: ['episodes'],
      },
      {
        label: 'open threads',
        sql: 'SELECT id, host, session_id, opened_at FROM threads WHERE closed_at IS NONE ORDER BY opened_at DESC;',
        description: 'Live host sessions still actively writing events.',
        tables: ['threads'],
      },
    ],
  },
  {
    group: 'entities',
    items: [
      {
        label: 'by name',
        sql: 'SELECT id, kind, name, slug FROM entities ORDER BY name LIMIT 100;',
        description:
          'First 100 entities alphabetically by name — handy to spot duplicate slugs or near-duplicate names that should probably be aliases.',
        tables: ['entities'],
      },
      {
        label: 'by kind',
        sql: 'SELECT kind, count() AS n FROM entities GROUP BY kind ORDER BY n DESC;',
        description: 'Breakdown of the knowledge graph by entity kind.',
        tables: ['entities'],
      },
    ],
  },
  {
    group: 'biographer',
    items: [
      {
        label: 'knowledge by topic',
        sql: "SELECT topic ?? 'uncategorized' AS topic, count() AS n FROM knowledge GROUP BY topic ORDER BY n DESC;",
        description: 'Distribution of distilled knowledge across topics.',
        tables: ['knowledge'],
      },
      {
        label: 'active rules',
        sql: "SELECT id, scope, directive FROM rules WHERE state = 'active';",
        description:
          "Rules currently shaping Robin's output. Each was promoted from a rule_candidate.",
        tables: ['rules'],
      },
      {
        label: 'pending rule candidates',
        sql: "SELECT id, directive, rationale, created FROM rule_candidates WHERE status = 'pending' ORDER BY created DESC;",
        description:
          'Candidate rules dream has proposed but the user has not yet approved or rejected.',
        tables: ['rule_candidates'],
      },
      {
        label: 'strongest patterns',
        sql: 'SELECT id, pattern, signal_count FROM patterns ORDER BY signal_count DESC LIMIT 25;',
        description:
          'Recurring observations. High signal_count rows are candidates for promotion to a rule.',
        tables: ['patterns'],
      },
    ],
  },
  {
    group: 'runtime',
    items: [
      {
        label: 'config',
        sql: 'SELECT * FROM runtime;',
        description: 'Singleton runtime config rows — embedder profile, scheduler cursor, etc.',
        tables: ['runtime'],
      },
      {
        label: 'jobs',
        sql: 'SELECT name, next_run_at, last_run_at, in_flight FROM runtime_jobs ORDER BY next_run_at;',
        description: 'Background jobs the daemon scheduler is running.',
        tables: ['runtime_jobs'],
      },
      {
        label: 'active sessions',
        sql: "SELECT session_id, host, last_seen_at, state FROM runtime_sessions WHERE state = 'active' ORDER BY last_seen_at DESC;",
        description: 'Hosts currently connected to the daemon.',
        tables: ['runtime_sessions'],
      },
      {
        label: 'refusals',
        sql: 'SELECT id, ts, surface, action, reason FROM refusals ORDER BY ts DESC LIMIT 25;',
        description: 'Audit log of outbound actions Robin declined to perform.',
        tables: ['refusals'],
      },
    ],
  },
];
