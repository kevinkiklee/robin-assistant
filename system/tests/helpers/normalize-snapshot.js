const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g;
// Surreal record IDs ("events:abc123"). Negative lookbehind avoids URL
// fragments ("http://localhost:8000"); the digit-bearing suffix lookahead
// avoids identifier-pair noise like "tcp:localhost" or "my_table:id_value".
const SURREAL_ID = /(?<![/\w])([a-z_][a-z0-9_]*):(?=[A-Za-z0-9_]*[0-9])([A-Za-z0-9_]{2,})/g;
const PID = /pid=\d+/g;
const TOOK_MS = /"took_ms":\s*\d+/g;
const HUMAN_TIMESTAMP = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g;

export function normalize(s) {
  return s
    .replace(ISO_TIMESTAMP, '<TIMESTAMP>')
    .replace(SURREAL_ID, '$1:<ID>')
    .replace(PID, 'pid=<PID>')
    .replace(TOOK_MS, '"took_ms": <MS>');
}

export function normalizeDoctorOutput(s) {
  return s.replace(HUMAN_TIMESTAMP, '<TIMESTAMP>');
}
