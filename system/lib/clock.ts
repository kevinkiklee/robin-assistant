/**
 * Process-wide time source for the memory pipeline. Production never calls
 * setClock, so every reader returns real time. The test lab pins it to a
 * simulated clock — valid because exactly one lab copy runs per process
 * (docs/design/2026-10-19-robin-test-lab-design.md §8.1); sharing a process
 * between copies would require AsyncLocalStorage instead.
 */
let source: () => number = () => Date.now();

export function clockNow(): number {
  return source();
}

export function clockDate(): Date {
  return new Date(source());
}

export function clockIso(): string {
  return new Date(source()).toISOString();
}

export function setClock(fn: (() => number) | null): void {
  source = fn ?? (() => Date.now());
}
