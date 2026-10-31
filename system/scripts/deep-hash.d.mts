// system/scripts/deep-hash.d.mts — type declarations for deep-hash.mjs,
// kept plain JS (no build step, importable by write-build-stamp.mjs before
// or without tsc running) so this file exists purely to give TypeScript
// consumers (deep-hash.test.ts) real types instead of an implicit `any`.
export declare const SELF_IMPORTED_FILES: ReadonlySet<string>;
export declare function computeDeepHash(
  distRoot: string,
  excludeFiles?: ReadonlySet<string>,
): string | null;
