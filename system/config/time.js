// Shared duration constants. Use these instead of inlining `86400_000` /
// `86_400_000` or redefining `const DAY_MS` per module so the same name
// search finds every time-window consumer.

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
