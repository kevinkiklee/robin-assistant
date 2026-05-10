import { closeSync, openSync, readSync, statSync } from 'node:fs';

// Read the last N bytes of a file as utf8. Returns '' on any error.
// Used for tailing JSONL transcripts without loading the whole file.
export function readFileTail(filePath, maxBytes) {
  let fd;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return '';
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (typeof fd === 'number') {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
