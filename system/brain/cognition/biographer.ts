import { z } from 'zod';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { addRelation, findEntity, upsertEntity } from '../memory/entity.ts';

const extractionSchema = z.object({
  entities: z
    .array(
      z.object({
        type: z.string(),
        name: z.string(),
      }),
    )
    .default([]),
  relations: z
    .array(
      z.object({
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
      }),
    )
    .default([]),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

const disambiguationSchema = z.object({
  matched_id: z.number().int().nullable(),
  create_new: z.boolean(),
  reason: z.string(),
});

interface DisambiguationContext {
  type: string;
  name: string;
  sourceText: string;
}

export interface BiographerRunResult {
  processed: number;
  entitiesCreated: number;
  relationsCreated: number;
  errors: string[];
}

const SYSTEM_PROMPT = `You extract structured entities and relations from a transcript. Reply ONLY with JSON matching:
{"entities":[{"type":"person|place|topic|thing","name":"..."}, ...], "relations":[{"subject":"name","predicate":"verb","object":"name"}, ...]}
If nothing is worth extracting, reply {"entities":[],"relations":[]}.`;

/**
 * If multiple candidates exist for the extracted name, ask the LLM to pick one or
 * declare it new. Returns the entity id to use (or null = create new).
 */
export async function disambiguateEntity(
  db: RobinDb,
  llm: LLMDispatcher | null,
  ctx: DisambiguationContext,
): Promise<{ matchedId: number | null; reason: string }> {
  const candidates = findEntity(db, ctx.name, ctx.type);
  if (candidates.length === 0) return { matchedId: null, reason: 'no candidates' };
  if (candidates.length === 1) return { matchedId: candidates[0].id, reason: 'single candidate' };
  if (!llm)
    return {
      matchedId: candidates[0].id,
      reason: 'multiple candidates; LLM unavailable; picked oldest',
    };

  const candidateLines = candidates
    .map(
      (c) =>
        `- id=${c.id}, name="${c.canonical_name}", profile="${(c.profile ?? '').slice(0, 200)}"`,
    )
    .join('\n');
  const systemPrompt = `You disambiguate entity references. Given a name and several candidates, pick which one the source text refers to. Reply ONLY with JSON: {"matched_id": <id> | null, "create_new": <bool>, "reason": "<short>"}. If none fit, set matched_id=null and create_new=true.`;
  const userPrompt = `Source text:\n${ctx.sourceText.slice(0, 2000)}\n\nExtracted: type=${ctx.type}, name="${ctx.name}"\n\nCandidates:\n${candidateLines}`;
  try {
    const res = await llm.invoke('reasoning', {
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0,
    });
    const text = res.text
      .trim()
      .replace(/^```(?:json)?/, '')
      .replace(/```$/, '')
      .trim();
    const parsed = disambiguationSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return {
        matchedId: candidates[0].id,
        reason: `LLM returned invalid JSON; fell back to oldest`,
      };
    }
    if (parsed.data.create_new) return { matchedId: null, reason: parsed.data.reason };
    if (parsed.data.matched_id && candidates.some((c) => c.id === parsed.data.matched_id)) {
      return { matchedId: parsed.data.matched_id, reason: parsed.data.reason };
    }
    return { matchedId: candidates[0].id, reason: `LLM picked unknown id; fell back to oldest` };
  } catch {
    return { matchedId: candidates[0].id, reason: 'LLM call failed; fell back to oldest' };
  }
}

export async function runBiographer(
  db: RobinDb,
  llm: LLMDispatcher | null,
  limit: number = 10,
): Promise<BiographerRunResult> {
  const result: BiographerRunResult = {
    processed: 0,
    entitiesCreated: 0,
    relationsCreated: 0,
    errors: [],
  };

  // Find session.captured events with content that biographer has not yet processed
  const rows = db
    .prepare(`
    SELECT events.id AS eventId, events_content.id AS contentId, events_content.body AS body
      FROM events
      JOIN events_content ON events_content.id = events.content_ref
     WHERE events.kind = 'session.captured'
       AND events.id NOT IN (SELECT json_extract(payload, '$.source_event_id') FROM events WHERE kind = 'biographer.extracted')
     ORDER BY events.ts DESC
     LIMIT ?
  `)
    .all(limit) as Array<{ eventId: number; contentId: number; body: string }>;

  for (const row of rows) {
    result.processed++;
    let extracted: ExtractionResult = { entities: [], relations: [] };
    if (llm) {
      try {
        const inv = await llm.invoke('reasoning', {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: row.body.slice(0, 8000) }],
          temperature: 0,
        });
        const text = inv.text.trim();
        // Tolerate leading ```json fences
        const jsonText = text
          .replace(/^```(?:json)?/, '')
          .replace(/```$/, '')
          .trim();
        const parsed = JSON.parse(jsonText);
        const validated = extractionSchema.safeParse(parsed);
        if (validated.success) extracted = validated.data;
        else
          result.errors.push(
            `event ${row.eventId}: schema mismatch — ${validated.error.issues.map((i) => i.message).join('; ')}`,
          );
      } catch (err) {
        result.errors.push(
          `event ${row.eventId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Upsert entities with LLM-driven disambiguation
    const idByName = new Map<string, number>();
    for (const e of extracted.entities) {
      try {
        const { matchedId } = await disambiguateEntity(db, llm, {
          type: e.type,
          name: e.name,
          sourceText: row.body,
        });
        if (matchedId !== null) {
          idByName.set(e.name, matchedId);
        } else {
          const ent = upsertEntity(db, e.type, e.name);
          idByName.set(e.name, ent.id);
          result.entitiesCreated++;
        }
      } catch (err) {
        result.errors.push(`entity ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Add relations
    for (const r of extracted.relations) {
      const sId = idByName.get(r.subject) ?? upsertEntity(db, 'thing', r.subject).id;
      const oId = idByName.get(r.object) ?? upsertEntity(db, 'thing', r.object).id;
      addRelation(db, sId, r.predicate, oId, row.eventId);
      result.relationsCreated++;
    }

    // Write a 'biographer.extracted' event linking back to the source
    db.prepare(`
      INSERT INTO events (ts, kind, source, status, payload)
      VALUES (?, 'biographer.extracted', 'biographer', 'ok', ?)
    `).run(
      new Date().toISOString(),
      JSON.stringify({
        source_event_id: row.eventId,
        entities: extracted.entities.length,
        relations: extracted.relations.length,
      }),
    );
  }

  return result;
}
