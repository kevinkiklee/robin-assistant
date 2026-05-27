import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveUserDataDir } from '../../lib/paths.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';

export interface SessionTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface SessionCapture {
  sessionId: string;
  turns: SessionTurn[];
  endedAt?: string;
  /**
   * Working directory the Claude Code session ran in (from the SessionEnd hook
   * payload). Used to scope capture to Robin's own folder. Omit for programmatic
   * callers (CLI, tests) that don't have a meaningful cwd — the allowlist check
   * is skipped when this is undefined.
   */
  cwd?: string;
}

/**
 * Default cwd allowlist: the directory containing Robin's user-data dir (i.e.
 * `~/workspace/robin/robin-assistant-v3`). Override via `ROBIN_ALLOWED_CWDS`
 * env var (comma-separated absolute paths). A session is allowed if its cwd
 * exactly matches an entry or is a descendant of one.
 */
function getAllowedCwds(): string[] {
  const env = process.env.ROBIN_ALLOWED_CWDS;
  if (env) {
    return env
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  try {
    return [dirname(resolveUserDataDir())];
  } catch {
    return [];
  }
}

/** Returns true if cwd is undefined (skip check), or matches the allowlist. */
function isCwdAllowed(cwd: string | undefined, allowedCwds: string[]): boolean {
  if (cwd === undefined) return true;
  if (allowedCwds.length === 0) return true; // failed to resolve default → fail-open
  return allowedCwds.some((prefix) => cwd === prefix || cwd.startsWith(`${prefix}/`));
}

/**
 * Read a Claude Code transcript .jsonl file and project it into SessionTurn[] for capture.
 *
 * Claude Code transcript lines are JSON objects with shape `{type, message: {role, content}}`
 * where content is either a string (text-only turns) or an array of typed blocks (text /
 * tool_use / tool_result). We flatten to one SessionTurn per line, preferring readable text
 * content and falling back to a stringified block for non-text turns so the capture has
 * something to dedup/embed against.
 */
export function transcriptFileToCapture(
  sessionId: string,
  transcriptPath: string,
  cwd?: string,
): SessionCapture {
  const raw = readFileSync(transcriptPath, 'utf8');
  const turns: SessionTurn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const role = parsed.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = parsed.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as { type?: string; text?: string };
          if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
        }
      }
      text = parts.join('\n');
    }
    if (!text.trim()) continue;
    turns.push({ role, content: text });
  }
  return { sessionId, turns, cwd };
}

export interface CaptureResult {
  captured: boolean;
  skipReason?: string;
  eventId?: number;
}

export interface CaptureSessionOptions {
  /**
   * Override the cwd allowlist. Tests pass this to verify scoping behavior.
   * Production omits it, letting captureSession resolve via `ROBIN_ALLOWED_CWDS`
   * env or the default (Robin's project root).
   */
  allowedCwds?: string[];
}

/** Apply skip rules and (if not skipped) write a 'session.captured' event for biographer to process. */
export async function captureSession(
  db: RobinDb,
  llm: LLMDispatcher | null,
  capture: SessionCapture,
  options: CaptureSessionOptions = {},
): Promise<CaptureResult> {
  // Scope check first — cheapest skip rule, and the one Kevin asked for: Robin
  // should only capture sessions running from within its own folder. Programmatic
  // callers without a cwd (CLI invocations, tests not exercising this path) pass
  // through.
  const allowedCwds = options.allowedCwds ?? getAllowedCwds();
  if (!isCwdAllowed(capture.cwd, allowedCwds)) {
    return { captured: false, skipReason: 'cwd_not_allowed' };
  }

  const userTurns = capture.turns.filter((t) => t.role === 'user' && t.content.trim());
  const assistantTurns = capture.turns.filter((t) => t.role === 'assistant' && t.content.trim());

  if (assistantTurns.length === 0) return { captured: false, skipReason: 'no_assistant_turn' };

  const allText = capture.turns
    .map((t) => t.content)
    .join('')
    .trim();
  if (allText.length === 0) return { captured: false, skipReason: 'empty_turn' };

  const hasNonToolAssistant = capture.turns.some(
    (t) => t.role === 'assistant' && t.content.trim().length > 0,
  );
  const onlyToolTurns = !hasNonToolAssistant && capture.turns.some((t) => t.role === 'tool');
  if (onlyToolTurns) return { captured: false, skipReason: 'pure_tool_turn' };

  const lastUserText = userTurns[userTurns.length - 1]?.content.trim() ?? '';
  if (lastUserText.length < 5 && /^(ok|yes|no|thanks|sure|cool|done)$/i.test(lastUserText)) {
    return { captured: false, skipReason: 'single_word_ack' };
  }

  // Dedup: hash the user turns; check recent events for a match
  const hash = Buffer.from(userTurns.map((t) => t.content).join('|'))
    .toString('base64')
    .slice(0, 64);
  const existing = db
    .prepare(
      `SELECT id FROM events WHERE kind = 'session.captured' AND json_extract(payload, '$.hash') = ? LIMIT 1`,
    )
    .get(hash);
  if (existing) return { captured: false, skipReason: 'dedup_hit' };

  const content = capture.turns.map((t) => `[${t.role.toUpperCase()}]\n${t.content}`).join('\n\n');

  // Classify as dev vs personal so the biographer can skip dev-heavy sessions.
  // Conservative: only flags 'dev' when dev signals heavily dominate (>3:1 ratio
  // AND >10 total). Mixed/ambiguous → 'personal' (biographer still extracts).
  const category = classifySessionCategory(capture.turns);

  const r = await ingest(db, llm, {
    kind: 'session.captured',
    source: 'capture',
    content,
    payload: { sessionId: capture.sessionId, hash, turnCount: capture.turns.length, category },
  });
  return { captured: true, eventId: r.eventId };
}

// ─── Session classifier ───────────────────────────────────────────────────────
// Keyword-density heuristic: count dev-signal vs personal-signal words in the
// session text. No LLM call, zero cost, deterministic, easily tunable.

const DEV_SIGNAL_RE =
  /\b(?:function|component|bug|deploy|commit|migration|refactor|endpoint|schema|query|lint|build|typescript|webpack|eslint|biome|pnpm|yarn|dockerfile|kubernetes|terraform|stdout|stderr|stacktrace|pull request|merge conflict|rebase|cherry-pick|bundler|transpil|import from|export default|console\.log|git (?:add|commit|push|pull|diff|log|status|checkout|branch)|npm (?:install|run|test)|test (?:fail|pass)|type ?check|node_modules|package\.json|tsconfig)\b/gi;

const PERSONAL_SIGNAL_RE =
  /\b(?:photo(?:graph)?|camera|lens|dinner|restaurant|trip|travel|family|health|movie|film|music|song|album|weather|plan|recipe|workout|sleep|recovery|bird(?:ing)?|finance|budget|insurance|mortgage|rent|apartment|doctor|medication|prescription|calendar|birthday|holiday|vacation|flight|hotel|gift|clothing|wardrobe|barbecue|park|museum|gallery|concert|podcast|book|journal)\b/gi;

/** Classify a captured session as 'dev' or 'personal' based on keyword density. */
export function classifySessionCategory(turns: SessionTurn[]): 'dev' | 'personal' {
  const text = turns.map((t) => t.content).join(' ');
  const devHits = (text.match(DEV_SIGNAL_RE) ?? []).length;
  const personalHits = (text.match(PERSONAL_SIGNAL_RE) ?? []).length;
  // Flag dev when dev signals clearly dominate. Previous 3:1 threshold was too
  // lenient — let too many mixed coding sessions through as "personal", flooding
  // the graph with engineering noise. 2:1 with a lower floor catches the bulk of
  // coding sessions while still letting genuinely mixed sessions through.
  if (devHits > 6 && devHits > personalHits * 2) return 'dev';
  return 'personal';
}
