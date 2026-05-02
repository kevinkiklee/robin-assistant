// After 3.3.0, operations are unified into system/jobs/. Comprehensive
// validation lives in system/tests/jobs/. This file keeps a thin smoke check
// ensuring every shipped job def parses + validates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseJobFrontmatter, validateJobDef } from '../../scripts/jobs/lib/frontmatter.js';

const JOBS = fileURLToPath(new URL('../../jobs', import.meta.url));

test('every system job parses + validates', () => {
  for (const f of readdirSync(JOBS)) {
    if (!f.endsWith('.md')) continue;
    const content = readFileSync(join(JOBS, f), 'utf-8');
    const parsed = parseJobFrontmatter(content);
    assert.ok(parsed.frontmatter.name, `${f}: missing name`);
    assert.ok(parsed.frontmatter.description, `${f}: missing description`);
    const r = validateJobDef(parsed);
    assert.ok(r.valid, `${f}: ${(r.errors || []).join('; ')}`);
  }
});
