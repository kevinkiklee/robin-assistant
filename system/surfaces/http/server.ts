import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildPrimer } from '../../brain/cognition/primer.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { composeAutoRecall } from '../../brain/memory/auto-recall.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import {
  handleNoteLifecycle,
  handleNotePrompt,
  type NoteHookResult,
} from '../../lib/notes/note-session.ts';

export interface HttpServerDeps {
  db: RobinDb;
  /** LLM dispatcher for auto-recall's vector layer. Null/absent → lex-only recall. */
  llm?: LLMDispatcher | null;
  /** User-data dir — required for the auto-recall route (topic map + canonical docs). */
  userData?: string;
  port?: number;
  onHook?: (kind: string, payload: unknown) => Promise<void> | void;
  isHealthy: () => boolean;
}

export interface HttpHandle {
  server: Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}

/** Max request body size (1 MB). Prevents DoS from oversized payloads. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Note-capture diagnostics. Logs `err` only — never a prompt. */
const noteLog = createLogger({ module: 'note-session' });

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  let bytes = 0;
  for await (const chunk of req) {
    const str = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
    bytes += Buffer.byteLength(str);
    if (bytes > MAX_BODY_BYTES) throw new Error('request body too large');
    body += str;
  }
  return body;
}

/**
 * Loopback binding stops remote hosts, not the browser on this machine. A page
 * can POST to 127.0.0.1 (it carries an Origin), and with DNS rebinding its own
 * hostname resolves here so it can READ responses — the auto-recall and primer
 * routes return memory. Clients that belong here (curl hooks, the CLI) send a
 * loopback Host and no Origin.
 */
export function isLocalClientRequest(req: IncomingMessage, port: number): boolean {
  if (req.headers.origin !== undefined) return false;
  // Browsers stamp every request, even a no-cors GET without Origin; curl and Node don't.
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'none') return false;
  const host = req.headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export async function startHttpServer(deps: HttpServerDeps): Promise<HttpHandle> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Security headers — this is a localhost-only daemon, but defense in depth.
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : -1;
    if (!isLocalClientRequest(req, port)) {
      req.resume();
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    (async () => {
      try {
        if (req.method === 'GET' && req.url === '/health') {
          res.statusCode = deps.isHealthy() ? 200 : 503;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: deps.isHealthy(), ts: new Date().toISOString() }));
          return;
        }
        // SessionStart: build the LLM-free primer and return it as Claude Code's
        // `additionalContext` so the hook's stdout becomes injected session context.
        // buildPrimer is cheap (SQL + small file reads) and must never throw on the
        // hot path — an empty primer degrades gracefully to no injected context.
        if (req.method === 'POST' && req.url === '/hooks/session_start') {
          // Body is parsed best-effort for the note-session lifecycle, and drained
          // regardless (Claude Code posts session metadata) so the socket never wedges.
          const body = await readBody(req);
          // The note session survives /clear by pairing SessionEnd{clear} with the next
          // SessionStart{clear}. Parsing is best-effort; the primer path is unchanged.
          if (deps.userData) {
            try {
              const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
              handleNoteLifecycle({ kind: 'session_start', payload, userData: deps.userData });
            } catch (err) {
              noteLog.warn({ err }, 'note-session lifecycle failed (session_start)');
            }
          }
          let additionalContext = '';
          try {
            additionalContext = buildPrimer(deps.db);
          } catch {
            additionalContext = '';
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext,
              },
            }),
          );
          return;
        }
        // UserPromptSubmit: run auto-recall (keyword topic→canonical-doc map + recall
        // snippets) and return it as `additionalContext`, injected before Claude answers.
        // This route MUST precede the generic /hooks/ catch-all below. It never throws on
        // the hot path: any failure degrades to an empty additionalContext (no injection).
        if (req.method === 'POST' && req.url === '/hooks/user_prompt_submit') {
          const body = await readBody(req);
          let payload: Record<string, unknown> = {};
          try {
            payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
          } catch {
            payload = {};
          }
          const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
          const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
          const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;

          // Event-notes capture runs BEFORE auto-recall: a captured line is blocked (never
          // reaches the model), so recall would be wasted work. Own try/catch: a failure here
          // must fall through to the normal recall path, not swallow it.
          let note: NoteHookResult = { kind: 'passthrough' };
          if (prompt && deps.userData) {
            try {
              note = handleNotePrompt({ prompt, sessionId, cwd, userData: deps.userData });
            } catch (err) {
              noteLog.warn({ err }, 'note-session failed; passing prompt through');
            }
          }
          if (note.kind === 'block') {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                decision: 'block',
                reason: note.reason,
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  ...(note.sessionTitle ? { sessionTitle: note.sessionTitle } : {}),
                },
              }),
            );
            return;
          }

          let additionalContext = '';
          try {
            if (prompt && deps.userData) {
              const ctx = await composeAutoRecall({
                db: deps.db,
                llm: deps.llm ?? null,
                prompt,
                sessionId,
                cwd,
                userData: deps.userData,
              });
              additionalContext = ctx ?? '';
            }
          } catch {
            additionalContext = '';
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext,
              },
            }),
          );
          return;
        }
        if (req.method === 'POST' && req.url?.startsWith('/hooks/')) {
          const kind = req.url.slice('/hooks/'.length);
          const body = await readBody(req);
          let payload: unknown = {};
          if (body) {
            try {
              payload = JSON.parse(body);
            } catch {
              payload = { raw: body };
            }
          }
          if (kind === 'session_end' && deps.userData && payload && typeof payload === 'object') {
            try {
              handleNoteLifecycle({
                kind: 'session_end',
                payload: payload as Record<string, unknown>,
                userData: deps.userData,
              });
            } catch (err) {
              noteLog.warn({ err }, 'note-session lifecycle failed (session_end)');
            }
          }
          if (deps.onHook) await deps.onHook(kind, payload);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ accepted: true, kind }));
          return;
        }
        res.statusCode = 404;
        res.end('not found');
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
    })().catch(() => {
      // Guard: if the try/catch block itself throws (shouldn't happen, but
      // defensive), prevent an unhandled promise rejection from crashing the
      // daemon. The inner catch already handles all known error paths.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal error');
      }
    });
  });

  const requestedPort = deps.port ?? 41273;
  // Bind explicitly to IPv4 loopback. `localhost` resolves dual-stack but Node's HTTP
  // server binds to whatever the OS returns first — on macOS that's `::1` (IPv6-only),
  // which silently breaks any client that connects via 127.0.0.1 with no IPv6 fallback
  // (curl, simple POSTs from shell hooks, etc.). The daemon only ever receives
  // localhost traffic, so 127.0.0.1 is sufficient and predictable.
  const host = '127.0.0.1';

  return await new Promise<HttpHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      const address = server.address();
      if (typeof address === 'string' || !address) {
        reject(new Error('Server address is not available'));
        return;
      }
      const actualPort = address.port;
      resolve({
        server,
        port: actualPort,
        host,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      });
    });
  });
}
