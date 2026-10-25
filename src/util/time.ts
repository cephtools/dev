export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function ageHours(at: string, now: Date): number {
  return (now.getTime() - Date.parse(at)) / HOUR_MS;
}

/** True when `at` lies in the half-open interval (now - hours, now]. Future timestamps are excluded. */
export function inWindow(at: string, now: Date, hours: number): boolean {
  const age = ageHours(at, now);
  return age >= 0 && age < hours;
}

/** True when `at` lies in [now - toHours, now - fromHours), i.e. between two ages. */
export function inAgeRange(at: string, now: Date, fromHours: number, toHours: number): boolean {
  const age = ageHours(at, now);
  return age >= fromHours && age < toHours;
}

/**
 * Exponential decay: weight 1 at age 0, 0.5 at one half-life. Events in the future
 * (clock skew) are treated as age 0, events older than `cutoffHours` contribute 0.
 */
export function decay(ageH: number, halfLifeHours: number, cutoffHours = Infinity): number {
  if (ageH >= cutoffHours) return 0;
  return Math.pow(0.5, Math.max(0, ageH) / halfLifeHours);
}

/** Epoch millis of an ISO timestamp; null (never) maps to 0. */
export function ms(at: string | null | undefined): number {
  return at ? Date.parse(at) : 0;
}

export function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
