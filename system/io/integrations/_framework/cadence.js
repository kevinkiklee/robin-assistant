const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseCadence(input) {
  if (input === null || input === undefined) {
    throw new Error('cadence required');
  }
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input <= 0) {
      throw new Error(`cadence must be a positive integer in ms; got ${input}`);
    }
    return input;
  }
  if (typeof input !== 'string') {
    throw new Error(`cadence must be string or integer ms; got ${typeof input}`);
  }
  const match = /^(\d+)([mhd])$/.exec(input);
  if (!match) {
    throw new Error(`invalid cadence: ${input} (accepted: <n>m, <n>h, <n>d, or integer ms)`);
  }
  const n = Number.parseInt(match[1], 10);
  if (n <= 0) throw new Error(`cadence must be positive; got ${input}`);
  return n * UNIT_MS[match[2]];
}
