/** Platforms a manifest may be pinned to. */
export type ManifestPlatform = 'darwin' | 'linux';

const VALID: ReadonlySet<string> = new Set<ManifestPlatform>(['darwin', 'linux']);

/**
 * Does this integration/job manifest run on `platform`? An absent or empty
 * `platforms` means "everywhere". Pure; `platform` is injectable for tests.
 */
export function runsOnThisPlatform(
  m: { platforms?: readonly string[] },
  platform: string = process.platform,
): boolean {
  if (!m.platforms || m.platforms.length === 0) return true;
  return m.platforms.includes(platform);
}

/**
 * Validate a raw `platforms:` value from YAML. Returns the array when it is a
 * non-empty list of 'darwin' | 'linux'; otherwise undefined (the field is
 * ignored) and `warn` is called with the reason. Never throws.
 */
export function parsePlatforms(
  raw: unknown,
  warn: (msg: string) => void = () => {},
): ManifestPlatform[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((p) => VALID.has(p as string))) {
    warn(`ignoring invalid platforms ${JSON.stringify(raw)} (expected a list of darwin|linux)`);
    return undefined;
  }
  return raw as ManifestPlatform[];
}

/**
 * The operator-facing status line for a platform-skipped entry. A darwin-only
 * entry needs the Mac (the satellite that would run it from the VM doesn't
 * exist yet).
 */
export function platformSkipLabel(m: { platforms?: readonly string[] }): string {
  const only = `skipped — ${(m.platforms ?? []).join('/')}-only`;
  return m.platforms?.length === 1 && m.platforms[0] === 'darwin'
    ? `${only} (needs the Mac; satellite pending)`
    : only;
}
