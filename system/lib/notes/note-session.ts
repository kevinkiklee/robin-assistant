import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative } from 'node:path';
import { noteRawPath, noteSessionStatePath } from '../paths.ts';

/**
 * Event-notes capture (docs/design/2026-08-22-event-notes-capture-design.md).
 *
 * The daemon's UserPromptSubmit route calls `handleNotePrompt` before auto-recall. While a
 * session is active and bound to the caller's Claude Code session_id, every typed line is
 * appended to a raw markdown file and the prompt is BLOCKED (never reaches the model).
 * Control words use the `>>` sigil because Claude Code intercepts `/ ! ? @ :` itself.
 *
 * All I/O is synchronous on purpose: the route handler is an async IIFE per request and
 * two rapid lines must not interleave their read-count-append sequences.
 */

export interface NoteSessionState {
  slug: string;
  /** Words after the slug on `>>note`; never invented by compile. */
  title?: string;
  /** Claude Code session_id bound to the session. */
  sessionId: string;
  /** cwd of the binding window; used only as an extra guard on the /clear rebind. */
  cwd?: string;
  /** Absolute raw-file path. */
  file: string;
  startedAt: string;
  /** ISO-8601 with offset; drives staleness and dedupe. */
  lastEntryAt: string;
  /** Set by session_end{reason:clear}; consumed by session_start{source:clear}. */
  rebindUntil?: string;
}

export type NoteHookResult =
  | { kind: 'passthrough' }
  | { kind: 'block'; reason: string; sessionTitle?: string };

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const STALE_MS = 24 * 60 * 60 * 1000;
export const DEDUPE_MS = 60 * 1000;
export const REBIND_WINDOW_MS = 10 * 1000;

const ENTRY_RE = /^- \d{2}:\d{2} (.*)$/;
const HEADER_RE = /^#{1,6}\s+\S/;
const DAY_RE = /^# (\d{4}-\d{2}-\d{2})$/;
const START_RE = /^>>note\s+(\S+)(?:\s+(.+))?$/;

const PASSTHROUGH: NoteHookResult = { kind: 'passthrough' };
const START_HELP =
  'type lines. "# " starts a section, "^ " amends the last line, a leading " quotes verbatim. ' +
  '>>end stops. Ask Claude in another window.';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` in the machine's local zone — the right clock for a conference. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `HH:MM` local. */
export function localTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** ISO-8601 with the local UTC offset, e.g. `2026-08-23T09:12:04-04:00`. Date.parse reads it back. */
export function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${localDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

export function readState(userData: string): NoteSessionState | null {
  try {
    const parsed = JSON.parse(readFileSync(noteSessionStatePath(userData), 'utf8'));
    if (
      !parsed ||
      typeof parsed.slug !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.file !== 'string' ||
      typeof parsed.lastEntryAt !== 'string'
    ) {
      return null;
    }
    return parsed as NoteSessionState;
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename), same discipline as reliability-audit's writeArtifactAtomic. */
function writeState(userData: string, state: NoteSessionState): void {
  const finalPath = noteSessionStatePath(userData);
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmp = `${finalPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, finalPath);
}

function clearState(userData: string): void {
  rmSync(noteSessionStatePath(userData), { force: true });
}

export interface RawCounts {
  /** `- HH:MM …` lines. This is `n`. */
  entries: number;
  /** `## HH:MM …` lines. */
  sections: number;
  /** Text of the last entry's first line, for dedupe. */
  lastEntryText: string | null;
  /** Last `# YYYY-MM-DD` divider, for the day-change check. */
  lastDate: string | null;
}

/** Everything compile-time and ack-time needs is derived from the file, never persisted. */
export function countRaw(file: string): RawCounts {
  const out: RawCounts = { entries: 0, sections: 0, lastEntryText: null, lastDate: null };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const e = ENTRY_RE.exec(line);
    if (e) {
      out.entries += 1;
      out.lastEntryText = e[1];
      continue;
    }
    if (line.startsWith('## ')) {
      out.sections += 1;
      continue;
    }
    const d = DAY_RE.exec(line);
    if (d) out.lastDate = d[1];
  }
  return out;
}

function ensureRawFile(file: string, slug: string, title: string | undefined, now: Date): void {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  const head = [
    '---',
    `title: ${JSON.stringify(title ?? slug)}`,
    'kind: raw-notes',
    `slug: ${slug}`,
    `started: ${isoLocal(now)}`,
    '---',
    '',
  ].join('\n');
  writeFileSync(file, head, 'utf8');
}

function isStale(state: NoteSessionState, now: Date): boolean {
  return now.getTime() - Date.parse(state.lastEntryAt) > STALE_MS;
}

function blockMsg(reason: string, sessionTitle?: string): NoteHookResult {
  return sessionTitle ? { kind: 'block', reason, sessionTitle } : { kind: 'block', reason };
}

export function handleNotePrompt(input: {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  userData: string;
  now?: Date;
}): NoteHookResult {
  const now = input.now ?? new Date();
  const trimmed = input.prompt.trim();
  if (!trimmed) return PASSTHROUGH;
  const state = readState(input.userData);

  if (trimmed === '>>note') {
    if (!state) return blockMsg('📝 no active session — >>note <slug> [title]');
    const c = countRaw(state.file);
    const last = localTime(new Date(Date.parse(state.lastEntryAt)));
    const stale = isStale(state, now) ? ` (stale — >>note ${state.slug} to resume)` : '';
    return blockMsg(
      `📝 active "${state.slug}": ${c.entries} entries, ${c.sections} sections, last ${last}${stale}`,
    );
  }

  const start = START_RE.exec(trimmed);
  if (start) {
    const slug = start[1].toLowerCase();
    const title = start[2]?.trim();
    if (!SLUG_RE.test(slug)) return blockMsg(`📝 bad slug "${start[1]}" — a-z, 0-9, "-"`);
    if (!input.sessionId) return blockMsg("📝 can't start: hook payload has no session_id");
    const file = noteRawPath(input.userData, slug);
    const same = state?.slug === slug ? state : null;
    ensureRawFile(file, slug, title ?? same?.title, now);
    const next: NoteSessionState = {
      slug,
      sessionId: input.sessionId,
      file,
      startedAt: same ? same.startedAt : isoLocal(now),
      lastEntryAt: isoLocal(now),
    };
    const keptTitle = title ?? same?.title;
    if (keptTitle) next.title = keptTitle;
    if (input.cwd) next.cwd = input.cwd;
    writeState(input.userData, next);
    const superseded = state && state.slug !== slug ? ` (superseded "${state.slug}")` : '';
    return blockMsg(`📝 "${slug}" started — ${START_HELP}${superseded}`, `📝 notes: ${slug}`);
  }

  if (trimmed === '>>end') {
    if (!state) return blockMsg('📝 no active session');
    const c = countRaw(state.file);
    clearState(input.userData);
    const rel = relative(input.userData, state.file);
    return blockMsg(
      `📝 "${state.slug}" ended — ${c.entries} entries, ${c.sections} sections → ${rel}. ` +
        `Resume with >>note ${state.slug}. Compile with /note compile ${state.slug}`,
      `notes: ${state.slug} (ended)`,
    );
  }

  if (trimmed.startsWith('>>') || trimmed.startsWith('/')) return PASSTHROUGH;

  if (!state || state.sessionId !== input.sessionId || isStale(state, now)) return PASSTHROUGH;

  const lines = trimmed.split('\n');
  const first = lines[0];
  const time = localTime(now);

  if (HEADER_RE.test(first)) {
    const text = first.replace(/^#{1,6}\s+/, '').trim();
    appendWithDivider(state.file, `\n## ${time} ${text}\n`, now);
    const rest = lines.slice(1);
    if (rest.length === 0) {
      touch(input.userData, state, now);
      return blockMsg(`📝 § ${text}`);
    }
    // Continuation lines after a header can't hang off the header chunk itself (the raw-file
    // grammar has no children for `## HH:MM`), so they become one ordinary entry underneath it.
    appendWithDivider(state.file, `${entryChunk(time, rest)}\n`, now);
    touch(input.userData, state, now);
    return blockMsg(`📝 § ${text} · #${countRaw(state.file).entries}`);
  }

  const before = countRaw(state.file);
  const sinceLast = now.getTime() - Date.parse(state.lastEntryAt);
  if (before.lastEntryText === first && sinceLast < DEDUPE_MS) {
    return blockMsg(`📝 #${before.entries}`);
  }
  appendWithDivider(state.file, `${entryChunk(time, lines)}\n`, now);
  touch(input.userData, state, now);
  return blockMsg(`📝 #${countRaw(state.file).entries}`);
}

/** `- HH:MM <first>` plus two-space-indented continuation lines — the entry-line grammar. */
function entryChunk(time: string, lines: string[]): string {
  return [`- ${time} ${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`)].join('\n');
}

/** Append, preceded by a `# YYYY-MM-DD` divider when the file's last date isn't today. */
function appendWithDivider(file: string, chunk: string, now: Date): void {
  const today = localDate(now);
  const { lastDate } = countRaw(file);
  const divider = lastDate === today ? '' : `\n# ${today}\n`;
  appendFileSync(file, divider + chunk, 'utf8');
}

function touch(userData: string, state: NoteSessionState, now: Date): void {
  writeState(userData, { ...state, lastEntryAt: isoLocal(now) });
}

/**
 * `/clear` rotates the Claude Code session_id (SessionEnd reason:"clear", then SessionStart
 * source:"clear"). Pair the two within REBIND_WINDOW_MS so capture survives frequent
 * `/clear` use. `/compact` and `--resume` keep the id; nothing to do.
 * Best-effort: never throws, never touches the hook response.
 */
export function handleNoteLifecycle(input: {
  kind: 'session_end' | 'session_start';
  payload: Record<string, unknown>;
  userData: string;
  now?: Date;
}): void {
  try {
    const now = input.now ?? new Date();
    const state = readState(input.userData);
    if (!state) return;
    const p = input.payload;
    const sid = typeof p.session_id === 'string' ? p.session_id : undefined;

    if (input.kind === 'session_end') {
      if (p.reason === 'clear' && sid === state.sessionId) {
        writeState(input.userData, {
          ...state,
          rebindUntil: isoLocal(new Date(now.getTime() + REBIND_WINDOW_MS)),
        });
      }
      return;
    }

    if (p.source !== 'clear' || !sid || !state.rebindUntil) return;
    if (Date.parse(state.rebindUntil) < now.getTime()) return;
    const cwd = typeof p.cwd === 'string' ? p.cwd : undefined;
    if (cwd && state.cwd && cwd !== state.cwd) return;
    const { rebindUntil: _consumed, ...rest } = state;
    writeState(input.userData, { ...rest, sessionId: sid });
  } catch {
    // Lifecycle is best-effort; a bad payload or a racing state write must never surface.
  }
}
