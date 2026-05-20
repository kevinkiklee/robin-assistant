import type { RobinDb } from '../../brain/memory/db.ts';
import { createLogger } from '../logging/logger.ts';

export interface OtelExporterConfig {
  /** OTLP HTTP endpoint, e.g. https://api.honeycomb.io/v1/traces */
  endpoint?: string;
  /** Auth headers, e.g. { 'x-honeycomb-team': 'KEY' } */
  headers?: Record<string, string>;
  /** Service name; defaults to 'robin' */
  serviceName?: string;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{
    key: string;
    value: { stringValue?: string; intValue?: string; doubleValue?: number };
  }>;
  status: { code: number };
}

function rand(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function attr(key: string, value: unknown): OtlpSpan['attributes'][0] {
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: String(value) } };
}

/**
 * Export the last N events from the SQLite events table as OTLP spans.
 * Returns count of spans actually sent (0 if no endpoint configured).
 */
export async function exportRecentEventsAsOtel(
  db: RobinDb,
  cfg: OtelExporterConfig,
  limit = 500,
): Promise<{ sent: number; error?: string }> {
  const log = createLogger({ module: 'otel-exporter' });
  if (!cfg.endpoint) return { sent: 0 };

  const rows = db
    .prepare(
      'SELECT id, ts, kind, source, actor, duration_ms, status, payload FROM events ORDER BY ts DESC LIMIT ?',
    )
    .all(limit) as Array<{
    id: number;
    ts: string;
    kind: string;
    source: string;
    actor: string | null;
    duration_ms: number | null;
    status: string;
    payload: string;
  }>;

  if (rows.length === 0) return { sent: 0 };

  const traceId = rand(32);
  const spans: OtlpSpan[] = rows.map((r) => {
    const startMs = new Date(r.ts).getTime();
    const endMs = startMs + (r.duration_ms ?? 0);
    return {
      traceId,
      spanId: rand(16),
      name: r.kind,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: String(startMs * 1_000_000),
      endTimeUnixNano: String(endMs * 1_000_000),
      attributes: [
        attr('robin.event.id', r.id),
        attr('robin.event.source', r.source),
        attr('robin.event.status', r.status),
        ...(r.actor ? [attr('robin.event.actor', r.actor)] : []),
        ...(r.duration_ms !== null ? [attr('robin.event.duration_ms', r.duration_ms)] : []),
      ],
      status: { code: r.status === 'ok' ? 1 : r.status === 'error' ? 2 : 0 },
    };
  });

  const body = {
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', cfg.serviceName ?? 'robin')] },
        scopeSpans: [{ scope: { name: 'robin-otel-exporter' }, spans }],
      },
    ],
  };

  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      log.warn({ status: res.status, text }, 'otel export failed');
      return { sent: 0, error: `${res.status}: ${text}` };
    }
    return { sent: spans.length };
  } catch (err) {
    return { sent: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
