import { surql } from 'surrealdb';

const DEFAULT_CAP = 10;
const WINDOW_MS = 3_600_000;

function envCap(toolName) {
  const envKey = `${toolName.toUpperCase()}_RATE_LIMIT`;
  const raw = process.env[envKey];
  if (!raw) return DEFAULT_CAP;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_CAP;
  return n;
}

export async function checkRateLimit(db, toolName) {
  const cap = envCap(toolName);
  const now = Date.now();
  const cutoff = new Date(now - WINDOW_MS);

  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'outbound_rate')`)
    .collect();
  const value = rows[0]?.value ?? {};
  const toolRow = value[toolName] ?? {};
  const rawRecent = Array.isArray(toolRow.recent_writes) ? toolRow.recent_writes : [];
  const recent = rawRecent.filter((ts) => new Date(ts) >= cutoff);

  if (recent.length >= cap) {
    const oldest = new Date(recent[0]).getTime();
    const wait = Math.ceil((oldest + WINDOW_MS - now) / 1000);
    return { ok: false, reason: 'rate_limited', wait_seconds: wait, used: recent.length, cap };
  }

  recent.push(new Date(now).toISOString());
  const updatedTools = { ...value, [toolName]: { recent_writes: recent } };
  await db
    .query(surql`UPSERT type::record('runtime', 'outbound_rate') SET value = ${updatedTools}`)
    .collect();

  return { ok: true, used: recent.length, cap };
}
