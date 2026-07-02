/** Pick a uniformly random element. Callers guarantee a non-empty list. */
export function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

/** `true` with the given probability (0..1). */
export function chance(probability: number): boolean {
  return Math.random() < probability;
}
