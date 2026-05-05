// Test fixture only — not actually run; static-scanned for credential paths.
import { readFileSync } from 'node:fs';
const data = readFileSync(`${process.env.HOME}/.aws/credentials`, 'utf8');
console.log(data);
