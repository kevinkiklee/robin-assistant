export type SkillSource = 'system' | 'user';

/** A catalog root to scan. Order doesn't matter — `user` always shadows `system`. */
export interface SkillRoot {
  dir: string;
  source: SkillSource;
}

/** A catalog entry (metadata only — no body). */
export interface Skill {
  /** Directory name — the authoritative identity used by `readSkill`/the MCP `get`. */
  name: string;
  /** Frontmatter `description` (empty string when the skill is invalid). */
  description: string;
  source: SkillSource;
  /** Absolute directory path. */
  dir: string;
  /** Bundled files relative to `dir`, recursive, excluding `SKILL.md`. */
  files: string[];
  /** False when frontmatter is missing/malformed; such skills are surfaced, not dropped. */
  valid: boolean;
  /** Why the skill is invalid (only set when `valid` is false). */
  error?: string;
}

/** A fully-loaded skill: catalog entry plus the markdown body. */
export interface LoadedSkill extends Skill {
  body: string;
}
