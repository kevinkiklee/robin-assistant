// iMessage inbox poller.
//
// Reads ~/Library/Messages/chat.db (SQLite, WAL mode) every N seconds for
// new messages since the last seen ROWID, joining message + handle + chat +
// attachment so each row carries:
//   { rowid, guid, handle, chat_guid, chat_style, text, date_ms,
//     date_edited_ms, is_from_me, service, attachments: [{filename, mime_type, size_bytes, local_path, sha256?}] }
//
// Cursor stored in `runtime:imessage_cursor` ({ last_rowid }).
//
// Filters before emitting:
//   1. Skip is_from_me=1 (would echo our own sends)
//   2. Skip if allowlist deny
//
// Allowed rows are emitted as events via the supplied `recordEvent` adapter
// with source='imessage' and meta carrying the structured fields.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  appleDateToJsDate,
  classifyService,
  isAllowed,
  isFromMe,
  normalizeHandle,
} from './normalize.js';

const DEFAULT_CHAT_DB = join(homedir(), 'Library/Messages/chat.db');

// Joined query — message + handle + chat (one chat per message via cm.chat_id).
// LEFT JOIN attachments separately to avoid row-cardinality blowup; we batch
// per ROWID.
const QUERY_MESSAGES_SINCE = `
  SELECT
    m.ROWID            AS rowid,
    m.guid             AS guid,
    m.text             AS text,
    m.date             AS date,
    m.date_edited      AS date_edited,
    m.is_from_me       AS is_from_me,
    m.thread_originator_guid AS thread_originator_guid,
    m.associated_message_type AS associated_message_type,
    h.id               AS handle,
    h.service          AS service,
    c.guid             AS chat_guid,
    c.style            AS chat_style,
    c.display_name     AS chat_display_name
  FROM message m
  LEFT JOIN handle h ON m.handle_id = h.ROWID
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON cmj.chat_id = c.ROWID
  WHERE m.ROWID > ?
  ORDER BY m.ROWID ASC
  LIMIT ?
`;

const QUERY_ATTACHMENTS_FOR_MESSAGES = (placeholders) => `
  SELECT
    maj.message_id AS message_rowid,
    a.filename     AS filename,
    a.mime_type    AS mime_type,
    a.total_bytes  AS total_bytes,
    a.uti          AS uti
  FROM message_attachment_join maj
  JOIN attachment a ON maj.attachment_id = a.ROWID
  WHERE maj.message_id IN (${placeholders})
`;

export function openChatDb(path = DEFAULT_CHAT_DB) {
  if (!existsSync(path)) {
    const err = new Error(`chat.db not found at ${path} — needs Full Disk Access`);
    err.code = 'ENOCHATDB';
    throw err;
  }
  // readonly=true + WAL: safe concurrent reads with Messages.app.
  return new Database(path, { readonly: true, fileMustExist: true });
}

export function readMessagesSince(db, sinceRowid, { limit = 100 } = {}) {
  const rows = db.prepare(QUERY_MESSAGES_SINCE).all(sinceRowid ?? 0, limit);
  if (!rows.length) return [];
  // Batch-fetch attachments for the returned message ROWIDs.
  const ids = rows.map((r) => r.rowid);
  const placeholders = ids.map(() => '?').join(',');
  const attRows = db.prepare(QUERY_ATTACHMENTS_FOR_MESSAGES(placeholders)).all(...ids);
  const attByMsg = new Map();
  for (const a of attRows) {
    const list = attByMsg.get(a.message_rowid) ?? [];
    list.push({
      filename: a.filename ?? null,
      mime_type: a.mime_type ?? null,
      size_bytes: typeof a.total_bytes === 'number' ? a.total_bytes : null,
      uti: a.uti ?? null,
    });
    attByMsg.set(a.message_rowid, list);
  }
  return rows.map((r) => normalizeMessageRow(r, attByMsg.get(r.rowid) ?? []));
}

function normalizeMessageRow(r, attachments) {
  const date = appleDateToJsDate(r.date);
  const dateEdited = r.date_edited ? appleDateToJsDate(r.date_edited) : null;
  return {
    rowid: Number(r.rowid),
    guid: r.guid,
    handle: normalizeHandle(r.handle),
    chat_guid: r.chat_guid,
    chat_style: r.chat_style,
    chat_display_name: r.chat_display_name ?? null,
    text: r.text ?? '',
    date,
    date_ms: date ? date.getTime() : null,
    date_edited_ms: dateEdited ? dateEdited.getTime() : null,
    is_from_me: !!r.is_from_me,
    service: classifyService(r.service),
    thread_originator_guid: r.thread_originator_guid ?? null,
    associated_message_type: Number(r.associated_message_type ?? 0),
    attachments,
  };
}

/**
 * pollOnce — runs a single poll cycle. Idempotent (cursor-driven).
 *
 * deps:
 *   db, allowlist, recordEvent({ source, content, meta }), getCursor, setCursor
 *   limit (default 100), logger
 *
 * Returns: { polled, allowed, skipped_self, skipped_allowlist, new_cursor }
 */
export async function pollOnce({
  db,
  allowlist,
  recordEvent,
  getCursor,
  setCursor,
  limit = 100,
  logger = console,
}) {
  const cursor = await getCursor();
  const sinceRowid = Number.isInteger(cursor) ? cursor : 0;
  let rows = [];
  try {
    rows = readMessagesSince(db, sinceRowid, { limit });
  } catch (e) {
    logger.warn?.(`[imessage] readMessagesSince failed: ${e?.message ?? e}`);
    return { polled: 0, allowed: 0, skipped_self: 0, skipped_allowlist: 0, new_cursor: sinceRowid };
  }
  if (!rows.length) {
    return { polled: 0, allowed: 0, skipped_self: 0, skipped_allowlist: 0, new_cursor: sinceRowid };
  }
  let allowed = 0;
  let skippedSelf = 0;
  let skippedAllowlist = 0;
  for (const row of rows) {
    if (isFromMe(row)) {
      skippedSelf += 1;
      continue;
    }
    if (!isAllowed(row, allowlist)) {
      skippedAllowlist += 1;
      continue;
    }
    try {
      await recordEvent({
        source: 'imessage',
        content: formatContent(row),
        meta: buildMeta(row),
      });
      allowed += 1;
    } catch (e) {
      logger.warn?.(`[imessage] recordEvent failed for ROWID ${row.rowid}: ${e?.message ?? e}`);
    }
  }
  const newCursor = rows[rows.length - 1].rowid;
  await setCursor(newCursor);
  return {
    polled: rows.length,
    allowed,
    skipped_self: skippedSelf,
    skipped_allowlist: skippedAllowlist,
    new_cursor: newCursor,
  };
}

function formatContent(row) {
  if (row.associated_message_type !== 0) {
    return `[reaction:${row.associated_message_type}] ${row.text ?? ''}`.trim();
  }
  if (row.attachments?.length && !row.text) {
    return `[${row.attachments.length} attachment(s)]`;
  }
  return row.text ?? '';
}

function buildMeta(row) {
  return {
    channel: 'imessage',
    guid: row.guid,
    handle: row.handle,
    chat_guid: row.chat_guid,
    chat_is_group: row.chat_style === 43,
    chat_display_name: row.chat_display_name,
    service: row.service,
    date_ms: row.date_ms,
    date_edited_ms: row.date_edited_ms,
    thread_originator_guid: row.thread_originator_guid,
    associated_message_type: row.associated_message_type,
    attachments: row.attachments,
  };
}
