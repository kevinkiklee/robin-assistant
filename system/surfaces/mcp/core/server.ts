import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { dbFilePath, resolveUserDataDir } from '../../../lib/paths.ts';
import { loadModels } from '../../../kernel/config/load.ts';
import { buildDispatcherFromConfig } from '../../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../../brain/llm/dispatcher.ts';
import { recall } from '../../../brain/memory/recall.ts';
import { ingest } from '../../../brain/memory/ingest.ts';
import { findEntity, getEntity, upsertEntity } from '../../../brain/memory/entity.ts';

export interface CoreServerDeps {
  db: RobinDb;
  llm: LLMDispatcher | null;
}

export function buildCoreDeps(): CoreServerDeps {
  const userData = resolveUserDataDir();
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  let llm: LLMDispatcher | null = null;
  try {
    const models = loadModels(userData);
    llm = buildDispatcherFromConfig(models, { lenient: true });
  } catch {
    llm = null;
  }
  return { db, llm };
}

export function buildCoreServer(deps: CoreServerDeps): McpServer {
  const server = new McpServer({ name: 'robin-core', version: '3.0.0-alpha.0' });

  server.registerTool(
    'recall',
    {
      description: 'Search memory by query (lexical + vector hybrid). Returns ranked snippets.',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
        limit: z.number().int().optional().describe('Max results (default 10)'),
        mode: z.enum(['lex', 'vec', 'hybrid']).optional().describe('Search mode'),
      }),
    },
    async ({ query, limit, mode }) => {
      const hits = await recall(deps.db, deps.llm, query, { limit, mode });
      return { content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }] };
    },
  );

  server.registerTool(
    'remember',
    {
      description: 'Write a fact, observation, or memory to the event log.',
      inputSchema: z.object({
        content: z.string().describe('What to remember'),
        kind: z.string().optional().describe("Event kind tag (default: 'memory.remember')"),
        source: z.string().optional().describe("Source label (default: 'mcp')"),
      }),
    },
    async ({ content, kind, source }) => {
      const r = await ingest(deps.db, deps.llm, {
        kind: kind ?? 'memory.remember',
        source: source ?? 'mcp',
        content,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ eventId: r.eventId, embedded: r.embedded }) }] };
    },
  );

  server.registerTool(
    'find_entity',
    {
      description: 'Search entities by name (partial match).',
      inputSchema: z.object({
        query: z.string().describe('Name to search'),
        type: z.string().optional().describe('Filter by entity type'),
      }),
    },
    async ({ query, type }) => {
      const hits = findEntity(deps.db, query, type);
      return { content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }] };
    },
  );

  server.registerTool(
    'get',
    {
      description: 'Generic getter for entity by id or canonical lookup by type+key.',
      inputSchema: z.object({
        type: z.string().describe('Entity type or "entity"'),
        id: z.number().int().optional().describe('Numeric id to fetch'),
        key: z.string().optional().describe('Canonical name (used with type)'),
      }),
    },
    async ({ type, id, key }) => {
      if (id !== undefined) {
        const e = getEntity(deps.db, id);
        return { content: [{ type: 'text' as const, text: JSON.stringify(e) }] };
      }
      if (key) {
        const e = upsertEntity(deps.db, type, key);
        return { content: [{ type: 'text' as const, text: JSON.stringify(e) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'must provide id or key' }) }] };
    },
  );

  server.registerTool(
    'list',
    {
      description: 'Generic lister for entities, events, jobs, predictions, corrections.',
      inputSchema: z.object({
        type: z.enum(['entities', 'events', 'jobs', 'predictions', 'corrections']).describe('What to list'),
        limit: z.number().int().optional().describe('Max rows (default 20)'),
      }),
    },
    async ({ type, limit }) => {
      const lim = limit ?? 20;
      let rows: unknown[] = [];
      switch (type) {
        case 'entities':
          rows = deps.db.prepare('SELECT * FROM entities ORDER BY updated_at DESC LIMIT ?').all(lim) as unknown[];
          break;
        case 'events':
          rows = deps.db.prepare('SELECT id, ts, kind, source, status FROM events ORDER BY ts DESC LIMIT ?').all(lim) as unknown[];
          break;
        case 'jobs':
          rows = deps.db.prepare('SELECT * FROM jobs ORDER BY scheduled_at DESC LIMIT ?').all(lim) as unknown[];
          break;
        case 'predictions':
          rows = (deps.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='predictions'").all() as unknown[]).length > 0
            ? (deps.db.prepare('SELECT * FROM predictions ORDER BY created_at DESC LIMIT ?').all(lim) as unknown[])
            : [];
          break;
        case 'corrections':
          rows = (deps.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='corrections'").all() as unknown[]).length > 0
            ? (deps.db.prepare('SELECT * FROM corrections ORDER BY ts DESC LIMIT ?').all(lim) as unknown[])
            : [];
          break;
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    },
  );

  return server;
}
