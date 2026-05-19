import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type Policies, policiesSchema } from './schema.ts';

export function loadPolicies(userDataDir: string): Policies {
  const file = join(userDataDir, 'config', 'policies.yaml');
  let raw: unknown = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    raw = parseYaml(text) ?? {};
  }
  const parsed = policiesSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid policies.yaml: ${issues}`);
  }
  return parsed.data;
}
