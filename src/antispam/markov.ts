export interface MarkovArtifact {
  order: 3;
  alpha: 1;
  weight: 0.1;
  alphabet: string[];
  spam: Array<[string, string, number]>;
  normal: Array<[string, string, number]>;
}
const UNKNOWN = '\0';
const MAX_TRANSITIONS = 200_000;

/** Both classes share an alphabet and one explicit unknown-symbol bucket. */
export function trainMarkov(
  samples: ReadonlyArray<{ normalized_text: string; label: number }>,
): MarkovArtifact {
  const symbols = new Set<string>();
  for (const sample of samples)
    for (const c of sample.normalized_text) {
      if (c !== UNKNOWN) symbols.add(c);
      if (symbols.size > 8192) throw new Error('Markov alphabet limit exceeded');
    }
  const alphabet = [...symbols].sort();
  const tables = [new Map<string, Map<string, number>>(), new Map<string, Map<string, number>>()];
  let entries = 0;
  for (const sample of samples) {
    const table = tables[sample.label];
    if (!table) throw new Error('Invalid Markov label');
    const chars = Array.from(sample.normalized_text);
    for (let i = 3; i < chars.length; i++) {
      const context = chars.slice(i - 3, i).join(''),
        symbol = chars[i] ?? UNKNOWN;
      const counts = table.get(context) ?? new Map<string, number>();
      if (!counts.has(symbol) && ++entries > MAX_TRANSITIONS)
        throw new Error('Markov transition limit exceeded');
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
      table.set(context, counts);
    }
  }
  const serialize = (table: Map<string, Map<string, number>>): Array<[string, string, number]> =>
    [...table].flatMap(([context, counts]) =>
      [...counts].map(([symbol, count]): [string, string, number] => [context, symbol, count]),
    );
  return {
    order: 3,
    alpha: 1,
    weight: 0.1,
    alphabet,
    spam: serialize(tables[1] ?? new Map()),
    normal: serialize(tables[0] ?? new Map()),
  };
}

export function validateMarkov(input: unknown): MarkovArtifact {
  const m = input as MarkovArtifact;
  if (
    m?.order !== 3 ||
    m.alpha !== 1 ||
    m.weight !== 0.1 ||
    !Array.isArray(m.alphabet) ||
    m.alphabet.length > 8192 ||
    m.alphabet.some((c) => typeof c !== 'string' || Array.from(c).length !== 1 || c === UNKNOWN) ||
    new Set(m.alphabet).size !== m.alphabet.length ||
    !Array.isArray(m.spam) ||
    !Array.isArray(m.normal) ||
    m.spam.length + m.normal.length > MAX_TRANSITIONS
  )
    throw new Error('Invalid Markov artifact');
  const allowed = new Set([...m.alphabet, UNKNOWN]);
  for (const rows of [m.spam, m.normal]) {
    const seen = new Set<string>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 3) throw new Error('Invalid Markov transition');
      const [context, symbol, count] = row;
      if (
        typeof context !== 'string' ||
        Array.from(context).length !== 3 ||
        Array.from(context).some((c) => !allowed.has(c)) ||
        typeof symbol !== 'string' ||
        !allowed.has(symbol) ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 200_000_000
      )
        throw new Error('Invalid Markov transition');
      const key = JSON.stringify([context, symbol]);
      if (seen.has(key)) throw new Error('Duplicate Markov transition');
      seen.add(key);
    }
  }
  return m;
}

export class MarkovSignal {
  private readonly alphabet: Set<string>;
  private readonly tables: Array<Map<string, { total: number; counts: Map<string, number> }>>;
  constructor(input: unknown) {
    const m = validateMarkov(input);
    this.alphabet = new Set(m.alphabet);
    this.tables = [m.spam, m.normal].map((rows) => {
      const table = new Map<string, { total: number; counts: Map<string, number> }>();
      for (const [context, symbol, count] of rows) {
        const entry = table.get(context) ?? { total: 0, counts: new Map<string, number>() };
        entry.total += count;
        entry.counts.set(symbol, count);
        table.set(context, entry);
      }
      return table;
    });
  }
  /** Mean log likelihood avoids underflow and dependence on message length. */
  score(text: string): number | null {
    const chars = Array.from(text).map((c) => (this.alphabet.has(c) ? c : UNKNOWN));
    if (chars.length <= 3) return null;
    const likelihood = this.tables.map((table) => {
      let sum = 0;
      for (let i = 3; i < chars.length; i++) {
        const entry = table.get(chars.slice(i - 3, i).join(''));
        sum += Math.log(
          ((entry?.counts.get(chars[i] ?? UNKNOWN) ?? 0) + 1) /
            ((entry?.total ?? 0) + this.alphabet.size + 1),
        );
      }
      return sum / (chars.length - 3);
    });
    const d = (likelihood[0] ?? 0) - (likelihood[1] ?? 0);
    return d >= 0 ? 1 / (1 + Math.exp(-d)) : Math.exp(d) / (1 + Math.exp(d));
  }
}

export function combineScores(classifier: number | null, markov: number | null): number | null {
  return classifier === null
    ? null
    : markov === null
      ? classifier
      : 0.9 * classifier + 0.1 * markov;
}
