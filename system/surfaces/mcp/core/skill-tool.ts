import {
  listSkills,
  readSkill,
  type Skill,
  type SkillRoot,
} from '../../../skills/_runtime/loader.ts';

export interface SkillToolArgs {
  /** Directory name of the skill to load (from the catalog). */
  name?: string;
  /** `list` returns the full catalog including invalid skills (for debugging). */
  action?: 'list';
}

/**
 * The `skill` MCP tool's description, generated at server startup. It embeds the
 * catalog of VALID skills (name + source + description) so the catalog is always
 * visible in the model's tool list — Robin discovers skills without a separate
 * call. Fixed for the life of the MCP-server process; refreshes on next startup.
 */
export function skillCatalogDescription(roots: SkillRoot[]): string {
  const skills = listSkills(roots).filter((s) => s.valid);
  const intro =
    'Load a Robin skill — a reusable, named methodology for a specialized task. ' +
    'Call with {name} to load the full skill (returns its instructions plus any ' +
    'bundled file paths you can read/run yourself).';
  if (skills.length === 0) {
    return `${intro} No skills are currently installed.`;
  }
  const lines = skills.map((s) => `- ${s.name} (${s.source}): ${s.description}`).join('\n');
  return `${intro}\n\nAvailable skills:\n${lines}`;
}

/** Catalog entry without filesystem internals — what callers see for `list`-less calls. */
function publicEntry(s: Skill): Pick<Skill, 'name' | 'description' | 'source'> {
  return { name: s.name, description: s.description, source: s.source };
}

/**
 * Execute the `skill` tool. Pure over the roots + args so it's unit-testable
 * without the MCP transport.
 * - `{ name }`        → load that skill (body + files + dir), or an error listing valid names.
 * - `{ action:'list'}`→ the full catalog as data, including invalid skills + their errors.
 * - `{}`             → the valid-skill catalog, metadata only (no bodies).
 */
export function runSkillTool(roots: SkillRoot[], args: SkillToolArgs): unknown {
  if (args.action === 'list') {
    return { skills: listSkills(roots) };
  }
  if (args.name) {
    const loaded = readSkill(roots, args.name);
    if (!loaded) {
      const available = listSkills(roots)
        .filter((s) => s.valid)
        .map((s) => s.name);
      return { error: `unknown skill '${args.name}'`, available };
    }
    return loaded;
  }
  return {
    skills: listSkills(roots)
      .filter((s) => s.valid)
      .map(publicEntry),
  };
}
