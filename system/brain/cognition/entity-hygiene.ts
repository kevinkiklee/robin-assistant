import { z } from 'zod';
import { clockDate } from '../../lib/clock.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';
import { collectMergeSnapshot, mergeEntities } from '../memory/merge.ts';
import { normalizeEntityName } from '../memory/normalize.ts';

/**
 * Entity hygiene: collapse entities that are the same real-world thing under
 * different names. The write-time dedup (normalizeEntityName + entity_aliases)
 * only catches punctuation/case variants, so a store can hold zero exact
 * normalized dupes yet many gear/product rows for one item ("Aero 38", "Velora
 * Aero 38mm Wheelset", "Aero 38mm wheelset", one with a wrong spec), several
 * for one model generation.
 *
 * Same two-stage shape as topic-hygiene.ts: a cheap lexical pass only NOMINATES
 * (gear-aware normalization — brand words, f-numbers, mm, PF/S/VR, roman-numeral
 * model suffixes — then token Jaccard / containment within a type-compatibility
 * class), grouped greedily into small candidate groups; an LLM judge
 * (`classify`) partitions each group into same-thing clusters and names the
 * canonical. LLM failure = no merge.
 *
 * Merges go through mergeEntities (relations re-pointed, profiles coalesced);
 * every dropped name becomes an entity_aliases row so the biographer resolves
 * it to the survivor instead of re-forking it. Each judged group is recorded as
 * an `entity.hygiene` event (members + clusters); pairs it split are never
 * re-judged, and merged ids leave the table — so repeated runs converge.
 * A merged event carries the pre-merge relation snapshot (reversibility).
 */

const HYGIENE_KIND = 'entity.hygiene';
const HYGIENE_SOURCE = 'entity-hygiene';

/** Candidate groups judged per run. */
const DEFAULT_MAX_GROUPS = 12;
/** Groups per judge call — keeps each prompt small and a failed call cheap. */
const GROUPS_PER_CALL = 6;
/** Clusters merged per run — a bad judge day can only dent the store. */
const DEFAULT_MAX_MERGES = 10;
/** Largest candidate group shown to the judge. */
const DEFAULT_MAX_GROUP_SIZE = 10;
/** Token-set Jaccard floor for nominating a pair. */
const DEFAULT_MIN_JACCARD = 0.5;
/** A token shared by more entities than this pairs everything with everything —
 *  skipped during index fan-out (it still counts toward Jaccard). */
const TOKEN_FANOUT_CAP = 150;

/**
 * Type-compatibility classes over the entity types the biographer emits
 * (gear, place, product, event, person, service, …).
 * The biographer assigns lens/gear/camera/product/thing/tool inconsistently to
 * one physical item ("Aero 38" is gear, "Velora Aero 38 Wheelset" a product), so
 * they form one class. Types not listed here are their own class (species, event, book, …).
 */
const TYPE_CLASSES: Record<string, string> = {
  lens: 'equipment',
  gear: 'equipment',
  camera: 'equipment',
  product: 'equipment',
  thing: 'equipment',
  tool: 'equipment',
  person: 'person',
  artist: 'person',
  place: 'place',
  restaurant: 'place',
  organization: 'organization',
  company: 'organization',
  service: 'organization',
};

export function typeClass(type: string): string {
  return TYPE_CLASSES[type] ?? type;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'with', 'on', 'in', 'at', 'to']);

/** Words carrying no product identity in the equipment class: common brand/mount
 *  words (nikon/nikkor/z), and suffixes nearly every modern tele has. */
const GEAR_NOISE = new Set([
  ...STOPWORDS,
  'nikon',
  'nikkor',
  'z',
  's',
  'vr',
  'pf',
  'ed',
  'lens',
  'camera',
  'body',
]);

const ROMAN: Record<string, string> = { '2': 'ii', '3': 'iii', '4': 'iv' };

/**
 * Gear-aware normal form: `Acme Z 29mm f/2.4 S` → `acme 29 f2.4`,
 * `Brio K7 III` / `K 7III` → `k7iii`, `21-47mm f/3.3-5.9 OS` → `21-47 f3.3-5.9 os`.
 * Exported for tests.
 */
export function gearTokens(raw: string): string[] {
  let s = raw.normalize('NFKC').toLowerCase().replace(/[–—]/g, '-');
  s = s.replace(/[()[\]{},;:"'!?]/g, ' ');
  // Mark II / Mk2 / MkII → ii, before model glue.
  s = s.replace(/\b(?:mark|mk)\s*(ii|iii|iv|2|3|4)\b/g, (_m, r: string) => ` ${ROMAN[r] ?? r}`);
  // Apertures: f/2.4, f 2.4, F2.4, f/3.3-5.9 → f2.4 / f3.3-5.9.
  s = s.replace(
    /\bf\s*\/?\s*(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?)/g,
    (_m, n: string) => `f${n.replace(/\s+/g, '')}`,
  );
  // Model glue BEFORE stripping mm: a 1–2 letter prefix + a 1–2 digit number that
  // is not a focal length is a model ("K 5" → k5, "X 70" → x70…); "Z 29mm"
  // and "Z 290" (3 digits) stay a mount letter + focal length.
  s = s.replace(/\b([a-z]{1,2})\s+(\d{1,2})(?![\d.]|\s*mm|-\d)/g, '$1$2');
  // Focal lengths: 290mm / 290 mm → 290, 21-47mm → 21-47.
  s = s.replace(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*mm\b/g, '$1-$2');
  s = s.replace(/(\d+(?:\.\d+)?)\s*mm\b/g, '$1');
  // Separators split words, except a hyphen between digits (ranges stay one token).
  s = s.replace(/[/\\_]+/g, ' ').replace(/(?<!\d)-|-(?!\d)/g, ' ');
  // Roman-numeral generation suffix joins its model: "k7 iii" → k7iii.
  s = s.replace(/\b([a-z]+\d+[a-z]*)\s+(ii|iii|iv)\b/g, '$1$2');
  // Remaining punctuation: keep '+' and decimal points inside numbers.
  s = s.replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/[^\p{L}\p{N}\s.+-]+/gu, ' ');
  return [...new Set(s.split(/\s+/).filter((t) => t && !GEAR_NOISE.has(t)))];
}

/** Identity tokens of an entity name, normalized per compatibility class. */
export function entityTokens(name: string, cls: string): string[] {
  if (cls === 'equipment') return gearTokens(name);
  return [
    ...new Set(
      normalizeEntityName(name)
        .split(' ')
        .filter((t) => t && !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t))),
    ),
  ];
}

export interface EntityLite {
  id: number;
  type: string;
  name: string;
  relations: number;
  profile?: string | null;
}

export interface CandidateGroup {
  cls: string;
  /** Indices into the entity list, highest relation count first. */
  members: number[];
  score: number;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Nominate candidate groups: pairs within one compatibility class whose token
 * sets reach the Jaccard floor, or where one set is contained in the other (≥2
 * tokens, or 1 model-ish token carrying a digit in the equipment class —
 * "290 VR" → {290}). Pairs are then unioned greedily, best first, into groups of
 * at most `maxGroupSize`. Lexical only — judgment is the LLM's job. Pure (no DB),
 * so it can be measured against a read-only connection.
 */
export function nominateGroups(
  entities: EntityLite[],
  skip: Set<string>,
  opts: { minJaccard?: number; maxGroupSize?: number } = {},
): { pairs: number; groups: CandidateGroup[] } {
  const minJaccard = opts.minJaccard ?? DEFAULT_MIN_JACCARD;
  const maxGroupSize = opts.maxGroupSize ?? DEFAULT_MAX_GROUP_SIZE;
  const classes = entities.map((e) => typeClass(e.type));
  const tokens = entities.map((e, i) => new Set(entityTokens(e.name, classes[i])));

  const byToken = new Map<string, number[]>();
  for (let i = 0; i < entities.length; i++) {
    for (const t of tokens[i]) {
      const key = `${classes[i]}\u0000${t}`;
      const list = byToken.get(key);
      if (list) list.push(i);
      else byToken.set(key, [i]);
    }
  }

  const seen = new Set<string>();
  const pairs: Array<{ i: number; j: number; score: number }> = [];
  for (const list of byToken.values()) {
    if (list.length < 2 || list.length > TOKEN_FANOUT_CAP) continue;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const i = list[x];
        const j = list[y];
        const key = pairKey(entities[i].id, entities[j].id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (skip.has(key)) continue;
        const A = tokens[i];
        const B = tokens[j];
        let inter = 0;
        for (const t of A) if (B.has(t)) inter++;
        const union = A.size + B.size - inter;
        const jaccard = union === 0 ? 0 : inter / union;
        const small = Math.min(A.size, B.size);
        const smaller = A.size <= B.size ? A : B;
        const subset =
          inter === small &&
          (small >= 2 ||
            (small === 1 && classes[i] === 'equipment' && /\d/.test([...smaller][0] ?? '')));
        if (jaccard >= minJaccard || subset) pairs.push({ i, j, score: Math.max(jaccard, 0.5) });
      }
    }
  }
  pairs.sort((p, q) => q.score - p.score);

  // Greedy capped union-find.
  const parent = entities.map((_, i) => i);
  const size = entities.map(() => 1);
  const best = entities.map(() => 0);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const p of pairs) {
    const a = find(p.i);
    const b = find(p.j);
    if (a === b) continue;
    if (size[a] + size[b] > maxGroupSize) continue;
    parent[b] = a;
    size[a] += size[b];
    best[a] = Math.max(best[a], best[b], p.score);
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < entities.length; i++) {
    const r = find(i);
    if (size[r] < 2) continue;
    const list = byRoot.get(r);
    if (list) list.push(i);
    else byRoot.set(r, [i]);
  }
  const groups: CandidateGroup[] = [...byRoot.entries()].map(([root, members]) => ({
    cls: classes[root],
    members: members.sort(
      (x, y) => entities[y].relations - entities[x].relations || entities[x].id - entities[y].id,
    ),
    score: best[root],
  }));
  const weight = (g: CandidateGroup) => g.members.reduce((n, m) => n + entities[m].relations, 0);
  groups.sort(
    (g, h) => h.score - g.score || h.members.length - g.members.length || weight(h) - weight(g),
  );
  return { pairs: pairs.length, groups };
}

/** Every entity with its relation count. */
export function loadEntities(db: RobinDb): EntityLite[] {
  return db
    .prepare(
      `SELECT e.id AS id, e.type AS type, e.canonical_name AS name, e.profile AS profile,
              COALESCE(r.n, 0) AS relations
         FROM entities e
         LEFT JOIN (SELECT id, COUNT(*) AS n
                      FROM (SELECT subject_id AS id FROM relations
                            UNION ALL SELECT object_id FROM relations)
                     GROUP BY id) r ON r.id = e.id
        ORDER BY e.id`,
    )
    .all() as EntityLite[];
}

/** Entity-id pairs a judge already split into different clusters — never re-judge. */
export function loadDistinctPairs(db: RobinDb): Set<string> {
  const rows = db
    .prepare(
      `SELECT payload FROM events
        WHERE kind = '${HYGIENE_KIND}' AND json_extract(payload,'$.verdict') = 'judged'`,
    )
    .all() as Array<{ payload: string }>;
  const set = new Set<string>();
  for (const r of rows) {
    let p: { members?: unknown; clusters?: unknown };
    try {
      p = JSON.parse(r.payload);
    } catch {
      continue;
    }
    if (!Array.isArray(p.members)) continue;
    const ids = p.members.filter((x): x is number => typeof x === 'number');
    const clusterOf = new Map<number, number>();
    if (Array.isArray(p.clusters)) {
      p.clusters.forEach((c, n) => {
        if (Array.isArray(c)) for (const id of c) if (typeof id === 'number') clusterOf.set(id, n);
      });
    }
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const cx = clusterOf.get(ids[x]);
        if (cx !== undefined && cx === clusterOf.get(ids[y])) continue;
        set.add(pairKey(ids[x], ids[y]));
      }
    }
  }
  return set;
}

const VerdictSchema = z.object({
  groups: z.array(
    z.object({
      group: z.number(),
      clusters: z.array(
        z.object({
          members: z.array(z.number()),
          keep: z.number(),
          canonical_name: z.string(),
        }),
      ),
    }),
  ),
});

type GroupVerdict = z.infer<typeof VerdictSchema>['groups'][number];

function parseVerdicts(structured: unknown, text: string): GroupVerdict[] {
  const direct = VerdictSchema.safeParse(structured);
  if (direct.success) return direct.data.groups;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = VerdictSchema.safeParse(JSON.parse(m[0]));
    return parsed.success ? parsed.data.groups : [];
  } catch {
    return [];
  }
}

const JUDGE_SYSTEM = [
  'You audit a personal knowledge graph for duplicate entities: the same real-world thing stored under several names.',
  'For each GROUP, partition the candidates into clusters of entries that denote the SAME specific thing — the same product model, person, place, organization, or species.',
  'DISTINCT, never merge: different models or generations (X1 vs X1 II, X2 II vs X2 III), different sizes, capacities or specs that are each real products (a 2-slice toaster vs a 4-slice toaster; a 2019 model vs a 2023 model of the same kettle), an accessory vs the thing it fits (a carafe vs the coffee maker), a lid vs the pot, different people who share a name part, a place vs a business at it.',
  'A name whose spec is evidently a slip for the same item as the rest of its cluster (a wrong capacity on an otherwise identical blender the same owner uses) may join that cluster — only when the relations make it clear.',
  'A generic name that could mean more than one product (brand + size only, e.g. "Acme 6-quart" when the brand makes several 6-quart cookers) joins a cluster only when its relations pin it to that product.',
  'When unsure, leave entries out — false merges are worse than duplicates.',
  "List only clusters of 2+ members; omitted entries stay as they are. 'keep' is the member index whose record survives (prefer the most relations). 'canonical_name' is the clearest full name for the thing, using only facts present in the member names (e.g. \"Acme 6-Quart Pressure Cooker\").",
  'Return JSON only: {"groups":[{"group":<n>,"clusters":[{"members":[<i>,…],"keep":<i>,"canonical_name":"…"}]}, …]} covering every group (empty clusters array when nothing is a duplicate).',
].join(' ');

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function relationSample(db: RobinDb, id: number): string {
  const rows = db
    .prepare(
      `SELECT r.predicate AS p, o.canonical_name AS other, 'out' AS dir
         FROM relations r JOIN entities o ON o.id = r.object_id WHERE r.subject_id = ?
       UNION ALL
       SELECT r.predicate, s.canonical_name, 'in'
         FROM relations r JOIN entities s ON s.id = r.subject_id WHERE r.object_id = ?
       LIMIT 4`,
    )
    .all(id, id) as Array<{ p: string; other: string; dir: string }>;
  return rows.map((r) => (r.dir === 'out' ? `${r.p}→${r.other}` : `${r.other}→${r.p}`)).join('; ');
}

export interface ProposedCluster {
  keep: { id: number; type: string; name: string };
  drops: Array<{ id: number; type: string; name: string }>;
  canonical: string;
  applied: boolean;
}

export interface EntityHygieneProposal {
  cls: string;
  members: Array<{ id: number; type: string; name: string; relations: number }>;
  clusters: ProposedCluster[];
}

export interface EntityHygieneReport {
  entities: number;
  pairsNominated: number;
  groupsNominated: number;
  groupsJudged: number;
  clustersProposed: number;
  merged: number;
  entitiesRemoved: number;
  aliasesAdded: number;
  recordedJudged: number;
  proposals: EntityHygieneProposal[];
}

export interface EntityHygieneOpts {
  /** Write merges, aliases and verdict events. Default false — a dry run that
   *  still asks the judge but changes nothing. */
  apply?: boolean;
  /** Skip the judge; report nominated groups only (no LLM, no writes). */
  nominateOnly?: boolean;
  maxGroups?: number;
  maxMerges?: number;
  maxGroupSize?: number;
  minJaccard?: number;
  now?: Date;
}

/** Canonical names may only use facts already in the members' names — an
 *  invented spec ("corrected" aperture the judge made up) falls back to keep's name. */
function canonicalIsGrounded(canonical: string, cls: string, names: string[]): boolean {
  const pool = new Set(names.flatMap((n) => entityTokens(n, cls)));
  return entityTokens(canonical, cls).every((t) => pool.has(t));
}

/**
 * One bounded pass. Safe nightly (bounded groups/merges, LLM failure = no-op,
 * converges via recorded verdicts); `llm` null → nominates only.
 */
export async function runEntityHygiene(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: EntityHygieneOpts = {},
): Promise<EntityHygieneReport> {
  const apply = opts.apply === true;
  const maxGroups = opts.maxGroups ?? DEFAULT_MAX_GROUPS;
  const maxMerges = opts.maxMerges ?? DEFAULT_MAX_MERGES;
  const date = (opts.now ?? clockDate()).toISOString().slice(0, 10);

  const entities = loadEntities(db);
  const { pairs, groups } = nominateGroups(entities, loadDistinctPairs(db), {
    minJaccard: opts.minJaccard,
    maxGroupSize: opts.maxGroupSize,
  });
  const report: EntityHygieneReport = {
    entities: entities.length,
    pairsNominated: pairs,
    groupsNominated: groups.length,
    groupsJudged: 0,
    clustersProposed: 0,
    merged: 0,
    entitiesRemoved: 0,
    aliasesAdded: 0,
    recordedJudged: 0,
    proposals: [],
  };
  const batch = groups.slice(0, maxGroups);
  const memberView = (g: CandidateGroup) =>
    g.members.map((m) => ({
      id: entities[m].id,
      type: entities[m].type,
      name: entities[m].name,
      relations: entities[m].relations,
    }));
  if (opts.nominateOnly || !llm) {
    report.proposals = batch.map((g) => ({ cls: g.cls, members: memberView(g), clusters: [] }));
    return report;
  }

  for (let off = 0; off < batch.length; off += GROUPS_PER_CALL) {
    const chunk = batch.slice(off, off + GROUPS_PER_CALL);
    const prompt = chunk
      .map((g, n) => {
        const lines = g.members.map((m, i) => {
          const e = entities[m];
          const rel = relationSample(db, e.id);
          const prof = e.profile ? ` | profile: ${clip(e.profile.replace(/\s+/g, ' '), 160)}` : '';
          return `  [${i}] ${e.type} "${e.name}" — ${e.relations} relation${e.relations === 1 ? '' : 's'}${rel ? `; e.g. ${clip(rel, 200)}` : ''}${prof}`;
        });
        return [`GROUP ${n} (${g.cls})`, ...lines].join('\n');
      })
      .join('\n\n');

    let verdicts: GroupVerdict[];
    try {
      const res = await llm.invoke('classify', {
        systemPrompt: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        outputSchema: VerdictSchema,
        temperature: 0,
        maxTokens: 2048,
      });
      verdicts = parseVerdicts(res.structured, res.text);
    } catch {
      continue; // judge unavailable — no merge; these groups re-nominate next run
    }

    const answered = new Set<number>();
    for (const v of verdicts) {
      const g = chunk[v.group];
      if (!g || answered.has(v.group)) continue;
      answered.add(v.group);
      report.groupsJudged++;
      const proposal: EntityHygieneProposal = { cls: g.cls, members: memberView(g), clusters: [] };
      report.proposals.push(proposal);

      // Validate clusters: in-range, disjoint, ≥2 members, keep inside.
      const used = new Set<number>();
      const clusters: Array<{ idx: number[]; keep: number; canonical: string }> = [];
      for (const c of v.clusters) {
        const idx = [...new Set(c.members)].filter(
          (i) => Number.isInteger(i) && i >= 0 && i < g.members.length && !used.has(i),
        );
        if (idx.length < 2) continue;
        for (const i of idx) used.add(i);
        const names = idx.map((i) => entities[g.members[i]].name);
        // A member already carrying the canonical name is the survivor.
        const canon = c.canonical_name.trim();
        const exact = idx.find((i) => entities[g.members[i]].name === canon);
        const keep = exact ?? (idx.includes(c.keep) ? c.keep : idx[0]);
        let canonical = canon;
        if (
          exact === undefined &&
          (!canon || canon.length > 120 || !canonicalIsGrounded(canon, g.cls, names))
        ) {
          canonical = entities[g.members[keep]].name;
        }
        clusters.push({ idx, keep, canonical });
      }
      report.clustersProposed += clusters.length;

      for (const c of clusters) {
        const keep = entities[g.members[c.keep]];
        const drops = c.idx.filter((i) => i !== c.keep).map((i) => entities[g.members[i]]);
        const proposed: ProposedCluster = {
          keep: { id: keep.id, type: keep.type, name: keep.name },
          drops: drops.map((d) => ({ id: d.id, type: d.type, name: d.name })),
          canonical: c.canonical,
          applied: false,
        };
        proposal.clusters.push(proposed);
        if (!apply || report.merged >= maxMerges) continue;
        const added = applyCluster(db, keep, drops, c.canonical, date);
        proposed.applied = true;
        report.merged++;
        report.entitiesRemoved += drops.length;
        report.aliasesAdded += added;
      }

      if (apply) {
        const memberIds = g.members.map((m) => entities[m].id);
        ingest(db, null, {
          kind: HYGIENE_KIND,
          source: HYGIENE_SOURCE,
          payload: {
            verdict: 'judged',
            members: memberIds,
            clusters: clusters.map((c) => c.idx.map((i) => entities[g.members[i]].id)),
            external_id: `entity-hygiene:judged:${[...memberIds].sort((a, b) => a - b).join(',')}`,
          },
        });
        report.recordedJudged++;
      }
    }
  }
  return report;
}

/** Merge one judged cluster: rename the survivor to the canonical name when free,
 *  merge drops into it, register every retired name as an alias, log the merge
 *  with its pre-merge snapshot. One transaction. Returns aliases added. */
function applyCluster(
  db: RobinDb,
  keep: EntityLite,
  drops: EntityLite[],
  canonical: string,
  date: string,
): number {
  let added = 0;
  db.transaction(() => {
    const refs = [{ keep: keep.id, drops: drops.map((d) => d.id) }];
    const snapshot = collectMergeSnapshot(db, refs);
    let finalName = keep.name;
    if (canonical !== keep.name) {
      const norm = normalizeEntityName(canonical);
      const dropIds = drops.map((d) => d.id);
      const clash = db
        .prepare(
          `SELECT id FROM entities
            WHERE id <> ? AND id NOT IN (${dropIds.map(() => '?').join(',')})
              AND ((type = ? AND canonical_name = ?) OR normalized_name = ?)
            LIMIT 1`,
        )
        .get(keep.id, ...dropIds, keep.type, canonical, norm);
      if (!clash) finalName = canonical;
    }
    mergeEntities(db, refs, { apply: true });
    if (finalName !== keep.name) {
      db.prepare(
        `UPDATE entities SET canonical_name = ?, normalized_name = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(finalName, normalizeEntityName(finalName), keep.id);
    }
    const retired = [...drops.map((d) => d.name), ...(finalName !== keep.name ? [keep.name] : [])];
    // Existing aliases that pointed at a retired name follow it to the survivor.
    const repoint = db.prepare(
      `UPDATE entity_aliases SET canonical_name = ?, canonical_type = ? WHERE canonical_name = ?`,
    );
    const addAlias = db.prepare(
      `INSERT OR IGNORE INTO entity_aliases (alias, canonical_name, canonical_type, source)
       VALUES (?, ?, ?, '${HYGIENE_SOURCE}')`,
    );
    const finalNorm = normalizeEntityName(finalName);
    for (const name of retired) {
      repoint.run(finalName, keep.type, name);
      const alias = normalizeEntityName(name);
      if (alias === finalNorm) continue;
      added += addAlias.run(alias, finalName, keep.type).changes;
    }
    ingest(db, null, {
      kind: HYGIENE_KIND,
      source: HYGIENE_SOURCE,
      payload: {
        verdict: 'merged',
        date,
        keep: { id: keep.id, type: keep.type, name: keep.name },
        canonical: finalName,
        drops: drops.map((d) => ({
          id: d.id,
          type: d.type,
          name: d.name,
          profile: d.profile ?? null,
        })),
        snapshot,
        external_id: `entity-hygiene:merged:${keep.id}:${drops
          .map((d) => d.id)
          .sort((a, b) => a - b)
          .join(',')}`,
      },
    });
  })();
  return added;
}
