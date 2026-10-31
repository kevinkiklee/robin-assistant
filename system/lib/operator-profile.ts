import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveUserDataDir } from './paths.ts';

/**
 * Who the operator is, for prompts that need a name or a few lines of context
 * (the biographer picks better entity types when it knows the user's gear,
 * work and places). It lives in `user-data/config/operator.yaml` — gitignored —
 * so the public code carries no personal details and a fresh install isn't
 * told it belongs to someone else:
 *
 *   name: Quinn
 *   context: >-
 *     Context: The user is Quinn, a potter (…) who lives in …
 *   aliases: [quinnr]          # handles the operator also goes by (claim filters)
 *   private_terms: [Priya, Lakeport Kiln]   # never in tracked files (repo guard test)
 *   home: { lat: 51.5072, lng: -0.1276, label: Camden,     # weather + sky alerts
 *           tide_station: '…', taf_station: EGLC }        # NOAA CO-OPS id; ICAO
 *
 * Every field is optional. Missing file → generic ("the user", no context, no
 * home — location-based integrations skip rather than guess).
 */
export interface OperatorProfile {
  name: string | null;
  context: string | null;
  aliases: string[];
  /** Words that must never appear in tracked files (people, places, accounts). */
  privateTerms: string[];
  home: {
    lat: number;
    lng: number;
    label?: string;
    /** NOAA CO-OPS tide-prediction station id (digits). */
    tideStation?: string;
    /** ICAO aerodrome whose TAF/METAR cross-checks the fog read. */
    tafStation?: string;
  } | null;
}

const EMPTY: OperatorProfile = {
  name: null,
  context: null,
  aliases: [],
  privateTerms: [],
  home: null,
};

let cached: OperatorProfile | null = null;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function latLng(v: unknown): OperatorProfile['home'] {
  if (!v || typeof v !== 'object') return null;
  const { lat, lng, label, tide_station, taf_station } = v as Record<string, unknown>;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const out: NonNullable<OperatorProfile['home']> = { lat, lng };
  const name = str(label);
  if (name) out.label = name;
  const tide = str(String(tide_station ?? ''));
  if (tide && /^\d+$/.test(tide)) out.tideStation = tide;
  const taf = str(taf_station);
  if (taf && /^[A-Za-z0-9]{4}$/.test(taf)) out.tafStation = taf.toUpperCase();
  return out;
}

export function readOperatorProfile(userDataDir: string): OperatorProfile {
  const file = join(userDataDir, 'config', 'operator.yaml');
  if (!existsSync(file)) return EMPTY;
  const raw = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(str).filter((a): a is string => a !== null) : [];
  return {
    name: str(raw.name),
    context: str(raw.context),
    aliases: list(raw.aliases),
    privateTerms: list(raw.private_terms),
    home: latLng(raw.home),
  };
}

/**
 * Lazily read once per process — a long-running daemon picks up an edited
 * operator.yaml only on restart. Unresolvable user-data or a bad file → generic.
 */
export function operatorProfile(): OperatorProfile {
  if (cached) return cached;
  try {
    cached = readOperatorProfile(resolveUserDataDir());
  } catch (err) {
    // A test-lab isolation tripwire must stay loud; anything else degrades to generic
    // for this call only — a half-saved operator.yaml mustn't stick for the daemon's life.
    if ((err as Error)?.name === 'LabIsolationError') throw err;
    return EMPTY;
  }
  return cached;
}

/** The operator's name for prompts and labels; `fallback` when none is configured. */
export function operatorName(fallback = 'the user'): string {
  return operatorProfile().name ?? fallback;
}

/** Tests only. `null` clears the cache so the next read hits disk again. */
export function setOperatorProfileForTests(p: OperatorProfile | null): void {
  cached = p;
}
