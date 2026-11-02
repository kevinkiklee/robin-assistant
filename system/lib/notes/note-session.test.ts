import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { noteRawPath, noteSessionStatePath } from '../paths.ts';
import { handleNoteLifecycle, handleNotePrompt, readState } from './note-session.ts';

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'robin-notes-'));
}
/** Local-time anchor: 2027-02-11 14:33:04 in the test machine's zone. */
const T0 = new Date(2027, 1, 11, 14, 33, 4);
const at = (min: number, sec = 0) => new Date(T0.getTime() + min * 60_000 + sec * 1000);

function block(r: ReturnType<typeof handleNotePrompt>): { reason: string; sessionTitle?: string } {
  assert.equal(r.kind, 'block', `expected block, got ${JSON.stringify(r)}`);
  return r as { kind: 'block'; reason: string; sessionTitle?: string };
}

test('notes: >>note <slug> <title> starts a session, writes state and a raw file with frontmatter', () => {
  const ud = fresh();
  const r = block(
    handleNotePrompt({
      prompt: '>>note BAKE-EXPO-27 Regional Bake Expo',
      sessionId: 's1',
      cwd: '/w',
      userData: ud,
      now: T0,
    }),
  );
  assert.match(r.reason, /^📝 "bake-expo-27" started — /);
  assert.equal(r.sessionTitle, '📝 notes: bake-expo-27');
  const state = readState(ud);
  assert.ok(state);
  assert.equal(state.slug, 'bake-expo-27');
  assert.equal(state.title, 'Regional Bake Expo');
  assert.equal(state.sessionId, 's1');
  assert.equal(state.cwd, '/w');
  assert.equal(state.file, noteRawPath(ud, 'bake-expo-27'));
  assert.equal(existsSync(noteSessionStatePath(ud)), true);
  const raw = readFileSync(state.file, 'utf8');
  assert.match(
    raw,
    /^---\ntitle: "Regional Bake Expo"\nkind: raw-notes\nslug: bake-expo-27\nstarted: 2027-02-11T14:33:04/,
  );
});

test('notes: >>note with a bad slug or no session_id blocks with a message and writes nothing', () => {
  const ud = fresh();
  const bad = block(
    handleNotePrompt({ prompt: '>>note Bad_Slug!', sessionId: 's1', userData: ud, now: T0 }),
  );
  assert.match(bad.reason, /bad slug/);
  const noSid = block(handleNotePrompt({ prompt: '>>note ok-slug', userData: ud, now: T0 }));
  assert.match(noSid.reason, /no session_id/);
  assert.equal(readState(ud), null);
});

test('notes: >>note status reports no session, then the active counts', () => {
  const ud = fresh();
  const none = block(
    handleNotePrompt({ prompt: '>>note', sessionId: 's1', userData: ud, now: T0 }),
  );
  assert.match(none.reason, /no active session/);
  handleNotePrompt({ prompt: '>>note bake-expo-27', sessionId: 's1', userData: ud, now: T0 });
  const status = block(
    handleNotePrompt({ prompt: '>>note', sessionId: 'other', userData: ud, now: at(1) }),
  );
  assert.match(status.reason, /active "bake-expo-27": 0 entries, 0 sections, last 14:33/);
});

test('notes: >>note <other-slug> supersedes; same slug re-binds and keeps startedAt', () => {
  const ud = fresh();
  handleNotePrompt({ prompt: '>>note first', sessionId: 's1', userData: ud, now: T0 });
  const sup = block(
    handleNotePrompt({ prompt: '>>note second', sessionId: 's1', userData: ud, now: at(5) }),
  );
  assert.match(sup.reason, /superseded "first"/);
  assert.equal(existsSync(noteRawPath(ud, 'first')), true);
  const rebind = block(
    handleNotePrompt({ prompt: '>>note second', sessionId: 's9', userData: ud, now: at(10) }),
  );
  assert.doesNotMatch(rebind.reason, /superseded/);
  const state = readState(ud);
  assert.equal(state?.sessionId, 's9');
  assert.match(state?.startedAt ?? '', /T14:38:04/);
});

test('notes: >>end works from any session, reports counts and relative path, clears state', () => {
  const ud = fresh();
  handleNotePrompt({ prompt: '>>note bake-expo-27', sessionId: 's1', userData: ud, now: T0 });
  writeFileSync(
    noteRawPath(ud, 'bake-expo-27'),
    '---\ntitle: "x"\n---\n\n# 2027-02-11\n\n## 14:35 Keynote\n- 14:36 one\n- 14:37 two\n',
  );
  const end = block(
    handleNotePrompt({ prompt: '>>end', sessionId: 'another-window', userData: ud, now: at(5) }),
  );
  assert.equal(
    end.reason,
    '📝 "bake-expo-27" ended — 2 entries, 1 sections → content/sources/notes/bake-expo-27.md. Resume with >>note bake-expo-27. Compile with /note compile bake-expo-27',
  );
  assert.equal(end.sessionTitle, 'notes: bake-expo-27 (ended)');
  assert.equal(readState(ud), null);
  const again = block(
    handleNotePrompt({ prompt: '>>end', sessionId: 's1', userData: ud, now: at(6) }),
  );
  assert.equal(again.reason, '📝 no active session');
});

test('notes: other >> lines, / commands and empty prompts pass through', () => {
  const ud = fresh();
  handleNotePrompt({ prompt: '>>note bake-expo-27', sessionId: 's1', userData: ud, now: T0 });
  assert.equal(
    handleNotePrompt({ prompt: '>> what did she mean', sessionId: 's1', userData: ud, now: at(1) })
      .kind,
    'passthrough',
  );
  assert.equal(
    handleNotePrompt({
      prompt: '/note compile bake-expo-27',
      sessionId: 's1',
      userData: ud,
      now: at(1),
    }).kind,
    'passthrough',
  );
  assert.equal(
    handleNotePrompt({ prompt: '   ', sessionId: 's1', userData: ud, now: at(1) }).kind,
    'passthrough',
  );
});

function startSession(ud: string, now = T0): void {
  handleNotePrompt({ prompt: '>>note bake-expo-27', sessionId: 's1', userData: ud, now });
}
function raw(ud: string): string {
  return readFileSync(noteRawPath(ud, 'bake-expo-27'), 'utf8');
}

test('notes: entries append as "- HH:MM text" under a day divider and ack #n', () => {
  const ud = fresh();
  startSession(ud);
  const a = block(
    handleNotePrompt({
      prompt: 'she says the new oven',
      sessionId: 's1',
      userData: ud,
      now: at(3),
    }),
  );
  assert.equal(a.reason, '📝 #1');
  const b = block(
    handleNotePrompt({ prompt: 'q: does that apply', sessionId: 's1', userData: ud, now: at(4) }),
  );
  assert.equal(b.reason, '📝 #2');
  assert.ok(
    raw(ud).endsWith('\n# 2027-02-11\n- 14:36 she says the new oven\n- 14:37 q: does that apply\n'),
  );
  assert.match(readState(ud)?.lastEntryAt ?? '', /T14:37:04/);
});

test('notes: "# " header becomes "## HH:MM text", acks §, and is not counted as an entry', () => {
  const ud = fresh();
  startSession(ud);
  const h = block(
    handleNotePrompt({
      prompt: '## Keynote — Jane Doe',
      sessionId: 's1',
      userData: ud,
      now: at(2),
    }),
  );
  assert.equal(h.reason, '📝 § Keynote — Jane Doe');
  const e = block(
    handleNotePrompt({ prompt: 'first point', sessionId: 's1', userData: ud, now: at(3) }),
  );
  assert.equal(e.reason, '📝 #1');
  assert.ok(
    raw(ud).includes('\n# 2027-02-11\n\n## 14:35 Keynote — Jane Doe\n- 14:36 first point\n'),
  );
});

test('notes: "#hashtag" (no space) is an ordinary entry', () => {
  const ud = fresh();
  startSession(ud);
  const e = block(
    handleNotePrompt({ prompt: '#1 priority: ship', sessionId: 's1', userData: ud, now: at(3) }),
  );
  assert.equal(e.reason, '📝 #1');
  assert.ok(raw(ud).includes('\n- 14:36 #1 priority: ship\n'));
});

test('notes: multi-line paste is one entry with indented continuation lines; only the first line decides', () => {
  const ud = fresh();
  startSession(ud);
  const e = block(
    handleNotePrompt({
      prompt: 'agenda\n# not a header\nthird',
      sessionId: 's1',
      userData: ud,
      now: at(3),
    }),
  );
  assert.equal(e.reason, '📝 #1');
  assert.ok(raw(ud).includes('\n- 14:36 agenda\n  # not a header\n  third\n'));
  assert.equal(
    handleNotePrompt({ prompt: 'next', sessionId: 's1', userData: ud, now: at(4) }).kind,
    'block',
  );
  assert.match(raw(ud), /- 14:37 next\n$/);
});

test('notes: a pasted block whose first line is a header keeps the rest as one entry under it', () => {
  const ud = fresh();
  startSession(ud);
  const h = block(
    handleNotePrompt({
      prompt: '## Agenda\n- keynote\n- panel',
      sessionId: 's1',
      userData: ud,
      now: at(2),
    }),
  );
  assert.equal(h.reason, '📝 § Agenda · #1');
  assert.ok(raw(ud).includes('\n## 14:35 Agenda\n- 14:35 - keynote\n  - panel\n'));
  const e = block(handleNotePrompt({ prompt: 'next', sessionId: 's1', userData: ud, now: at(3) }));
  assert.equal(e.reason, '📝 #2');
});

test('notes: a new local date inserts a "# YYYY-MM-DD" divider once', () => {
  const ud = fresh();
  startSession(ud);
  handleNotePrompt({ prompt: 'day one', sessionId: 's1', userData: ud, now: at(3) });
  const nextDay = new Date(2027, 1, 12, 7, 45, 0);
  handleNotePrompt({ prompt: 'day two', sessionId: 's1', userData: ud, now: nextDay });
  handleNotePrompt({
    prompt: 'still day two',
    sessionId: 's1',
    userData: ud,
    now: new Date(2027, 1, 12, 7, 46, 0),
  });
  assert.ok(
    raw(ud).endsWith(
      '\n# 2027-02-11\n- 14:36 day one\n\n# 2027-02-12\n- 07:45 day two\n- 07:46 still day two\n',
    ),
  );
});

test('notes: an identical line within 60 s is deduped (same #n, no append); after 60 s it appends', () => {
  const ud = fresh();
  startSession(ud);
  block(handleNotePrompt({ prompt: 'same line', sessionId: 's1', userData: ud, now: at(3) }));
  const dup = block(
    handleNotePrompt({ prompt: 'same line', sessionId: 's1', userData: ud, now: at(3, 20) }),
  );
  assert.equal(dup.reason, '📝 #1');
  const later = block(
    handleNotePrompt({ prompt: 'same line', sessionId: 's1', userData: ud, now: at(5) }),
  );
  assert.equal(later.reason, '📝 #2');
  assert.equal(raw(ud).split('- 14:').length - 1, 2);
});

test('notes: n is derived from the file, so an out-of-band append is counted', () => {
  const ud = fresh();
  startSession(ud);
  block(handleNotePrompt({ prompt: 'one', sessionId: 's1', userData: ud, now: at(3) }));
  appendFileSync(noteRawPath(ud, 'bake-expo-27'), '- 14:37 added by Claude during an outage\n');
  const e = block(handleNotePrompt({ prompt: 'three', sessionId: 's1', userData: ud, now: at(5) }));
  assert.equal(e.reason, '📝 #3');
});

test('notes: session mismatch and stale state pass through; status says stale', () => {
  const ud = fresh();
  startSession(ud);
  assert.equal(
    handleNotePrompt({ prompt: 'from another window', sessionId: 's2', userData: ud, now: at(3) })
      .kind,
    'passthrough',
  );
  const dayLater = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
  assert.equal(
    handleNotePrompt({ prompt: 'too late', sessionId: 's1', userData: ud, now: dayLater }).kind,
    'passthrough',
  );
  const status = block(
    handleNotePrompt({ prompt: '>>note', sessionId: 's1', userData: ud, now: dayLater }),
  );
  assert.match(status.reason, /stale — >>note bake-expo-27 to resume/);
});

test('lifecycle: session_end{clear} for the bound session arms a rebind; session_start{clear} within 10 s re-binds', () => {
  const ud = fresh();
  startSession(ud);
  handleNoteLifecycle({
    kind: 'session_end',
    payload: { session_id: 's1', reason: 'clear', cwd: '/w' },
    userData: ud,
    now: at(3),
  });
  assert.match(readState(ud)?.rebindUntil ?? '', /T14:36:14/);
  handleNoteLifecycle({
    kind: 'session_start',
    payload: { session_id: 's2', source: 'clear', cwd: '/w' },
    userData: ud,
    now: at(3, 4),
  });
  const state = readState(ud);
  assert.equal(state?.sessionId, 's2');
  assert.equal(state?.rebindUntil, undefined);
  assert.equal(
    handleNotePrompt({ prompt: 'after clear', sessionId: 's2', userData: ud, now: at(4) }).kind,
    'block',
  );
});

test('lifecycle: an unrelated session_end, an expired window, a non-clear start, or a different cwd do not re-bind', () => {
  const ud = fresh();
  handleNotePrompt({
    prompt: '>>note bake-expo-27',
    sessionId: 's1',
    cwd: '/w',
    userData: ud,
    now: T0,
  });
  handleNoteLifecycle({
    kind: 'session_end',
    payload: { session_id: 'other', reason: 'clear' },
    userData: ud,
    now: at(1),
  });
  assert.equal(readState(ud)?.rebindUntil, undefined);

  handleNoteLifecycle({
    kind: 'session_end',
    payload: { session_id: 's1', reason: 'clear' },
    userData: ud,
    now: at(2),
  });
  handleNoteLifecycle({
    kind: 'session_start',
    payload: { session_id: 's3', source: 'clear', cwd: '/elsewhere' },
    userData: ud,
    now: at(2, 1),
  });
  assert.equal(readState(ud)?.sessionId, 's1');
  handleNoteLifecycle({
    kind: 'session_start',
    payload: { session_id: 's3', source: 'startup' },
    userData: ud,
    now: at(2, 2),
  });
  assert.equal(readState(ud)?.sessionId, 's1');
  handleNoteLifecycle({
    kind: 'session_start',
    payload: { session_id: 's3', source: 'clear', cwd: '/w' },
    userData: ud,
    now: at(2, 11),
  });
  assert.equal(readState(ud)?.sessionId, 's1');
});

test('lifecycle: no state and malformed payloads are no-ops and never throw', () => {
  const ud = fresh();
  assert.doesNotThrow(() =>
    handleNoteLifecycle({ kind: 'session_end', payload: { reason: 'clear' }, userData: ud }),
  );
  assert.doesNotThrow(() =>
    handleNoteLifecycle({ kind: 'session_start', payload: {}, userData: '/nonexistent/dir' }),
  );
});

test('notes: readState rejects a hand-edited/corrupt state file instead of trusting its shape', () => {
  const ud = fresh();
  mkdirSync(join(ud, 'state', 'runtime'), { recursive: true });
  writeFileSync(noteSessionStatePath(ud), JSON.stringify({ slug: 'x' }));
  assert.equal(readState(ud), null);
  assert.equal(
    handleNotePrompt({ prompt: 'a stray line', sessionId: 's1', userData: ud, now: T0 }).kind,
    'passthrough',
  );
});
