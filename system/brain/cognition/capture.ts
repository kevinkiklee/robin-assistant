import { createHash } from 'node:crypto';
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
export function getAllowedCwds(): string[] {
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

// Claude Code surfaces usage-limit / system notices as a standalone assistant
// turn (e.g. "You've hit your Sonnet limit · resets Jun 7 at 1am"). These are
// failed invocations carrying no real assistant work — kept short and matched
// tightly so a substantive response that merely *mentions* limits isn't caught.
const CLAUDE_NOTICE_RE =
  /^(you['’]ve hit your\b.{0,40}\blimit\b|.{0,40}\busage limit (reached|exceeded)\b|claude(\s+code)?\s+(api\s+)?error\b)/i;
export function isClaudeCodeNotice(content: string): boolean {
  const t = content.trim();
  return t.length > 0 && t.length < 300 && CLAUDE_NOTICE_RE.test(t);
}

/** Returns true if cwd is undefined (skip check), or matches the allowlist. */
export function isCwdAllowed(cwd: string | undefined, allowedCwds: string[]): boolean {
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
  // Claude Code occasionally posts a SessionEnd for a session whose transcript
  // file doesn't exist on disk (e.g. very short sessions, or cwd=$HOME sessions
  // whose .jsonl is never written). Reading it threw ENOENT, which surfaced as a
  // noisy 'session_end capture failed' error on every such hook. A missing
  // transcript is a clean skip, not a failure: return an empty capture and let
  // captureSession's skip rules ('no_assistant_turn'/'cwd_not_allowed') handle it.
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { sessionId, turns: [], cwd };
    }
    throw err;
  }
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

  // Skip failed `claude` invocations whose only "assistant" turn is a Claude Code
  // system notice — e.g. "You've hit your Sonnet limit · resets Jun 7 at 1am". A
  // retrying auto-resume loop that keeps hitting the usage limit emits hundreds of
  // these per hour; capturing them floods the biographer and makes it extract junk
  // entities from error text. Keys on the failure tell (notice-only assistant
  // content), which is robust to cognition-prompt format changes. A real session
  // that merely discusses limits has substantive assistant turns and is kept.
  if (!assistantTurns.some((t) => !isClaudeCodeNotice(t.content))) {
    return { captured: false, skipReason: 'claude_system_notice' };
  }

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

  // Robin's own cognition prompts — the biographer's chunk-extraction prompt
  // (`=== FULL SESSION ===`, biographer.ts) and the dream pass's entity-summary
  // prompt (`Recent observations: … Write the profile.`, dream.ts) — get run
  // through `claude` sessions and captured back as "user" sessions, a
  // self-referential loop that floods the biographer with its own output. Match
  // these markers in USER turns only: a real session that merely discusses them
  // carries the strings in assistant output, not user input.
  const isCognitionEcho = userTurns.some((t) => {
    const c = t.content;
    return (
      c.includes('=== FULL SESSION ===') ||
      (c.includes('Recent observations:') && c.includes('Write the profile.'))
    );
  });
  if (isCognitionEcho) return { captured: false, skipReason: 'robin_cognition_echo' };

  // Dedup: hash the user turns; check recent events for a match.
  // Must digest the FULL joined content, not a fixed-length prefix. An earlier
  // version used base64(content).slice(0,64) — only the first 48 bytes of the
  // first user turn — so every session opened with `/clear` (which injects an
  // identical `<local-command-caveat>…` preamble) collided to one hash and all
  // but the first were silently dropped as dedup_hit. SHA-256 over the whole
  // conversation keys on actual content.
  const hash = createHash('sha256')
    .update(userTurns.map((t) => t.content).join('|'))
    .digest('hex');
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

  const hasCodeBlocks = capture.turns.some((t) => t.role === 'assistant' && /```/.test(t.content));
  const hasToolUse = capture.turns.some((t) => t.role === 'tool');
  const topicHints = extractTopicHints(capture.turns);

  const r = await ingest(db, llm, {
    kind: 'session.captured',
    source: 'capture',
    content,
    payload: {
      sessionId: capture.sessionId,
      hash,
      turnCount: capture.turns.length,
      category,
      userTurnCount: userTurns.length,
      assistantTurnCount: assistantTurns.length,
      bodyChars: content.length,
      hasCodeBlocks,
      hasToolUse,
      topicHints,
    },
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

// ─── Topic hint extraction ──────────────────────────────────────────────────
// Cheap term-frequency pass over user turns. Stop-word filtered, no LLM.
// A recall bridge — noisy but immediate. The biographer produces authoritative
// topic tags later via session finalization.

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'need',
  'dare',
  'ought',
  'used',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'don',
  'now',
  'and',
  'but',
  'or',
  'if',
  'while',
  'about',
  'up',
  'that',
  'this',
  'it',
  'its',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'they',
  'them',
  'their',
  'what',
  'which',
  'who',
  'whom',
  'these',
  'those',
  'am',
  'also',
  'get',
  'got',
  'let',
  'like',
  'make',
  'see',
  'think',
  'know',
  'want',
  'going',
  'yes',
  'no',
  'ok',
  'okay',
  'sure',
  'thanks',
  'right',
]);

export function extractTopicHints(turns: SessionTurn[], maxHints = 5): string[] {
  const text = turns
    .filter((t) => t.role === 'user')
    .map((t) => t.content)
    .join(' ')
    .toLowerCase();
  const words = text.match(/[a-z]{3,}/g) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxHints)
    .map(([word]) => word);
}
