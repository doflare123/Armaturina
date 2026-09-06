import { normalizeMessage } from './normalizer.ts';

export interface Sample {
  text_hash: string;
  normalized_text: string;
  reduced_text: string;
  label: number;
  duplicate_count?: number;
}
export interface Metrics {
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}
export interface ModelArtifact {
  format: 1;
  normalizerVersion: 1;
  vocabulary: string[];
  idf: number[];
  weights: number[];
  intercept: number;
  metrics: Metrics;
  trainHashes: string[];
  validationHashes: string[];
  spamSamples: number;
  normalSamples: number;
  iterations: number;
}
export type SparseVector = Array<[number, number]>;

/** Unicode code points, matching the normalizer; never split emoji surrogate pairs. */
export function charCounts(text: string): Map<string, number> {
  const chars = Array.from(text);
  const counts = new Map<string, number>();
  for (let n = 3; n <= 5; n++)
    for (let i = 0; i <= chars.length - n; i++) {
      const term = chars.slice(i, i + n).join('');
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  return counts;
}

export function vectorize(
  text: string,
  vocabulary: ReadonlyMap<string, number>,
  idf: number[],
): SparseVector {
  const vector: SparseVector = [];
  let norm = 0;
  for (const [term, count] of charCounts(text)) {
    const index = vocabulary.get(term);
    if (index === undefined) continue;
    const value = (1 + Math.log(count)) * (idf[index] ?? 0);
    vector.push([index, value]);
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  return norm ? vector.map(([i, value]) => [i, value / norm]) : [];
}

export function sigmoid(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

export function probability(vector: SparseVector, weights: ArrayLike<number>, intercept: number) {
  let z = intercept;
  for (const [index, value] of vector) z += (weights[index] ?? 0) * value;
  return sigmoid(z);
}

/** Reject corrupt/incompatible JSON before replacing a cached model. No executable serialization. */
export function validateModel(input: unknown): ModelArtifact {
  const m = input as ModelArtifact;
  if (
    m?.format !== 1 ||
    m.normalizerVersion !== 1 ||
    !Array.isArray(m.vocabulary) ||
    m.vocabulary.length < 1 ||
    m.vocabulary.length > 30_000 ||
    m.vocabulary.some(
      (t) => typeof t !== 'string' || Array.from(t).length < 3 || Array.from(t).length > 5,
    ) ||
    new Set(m.vocabulary).size !== m.vocabulary.length ||
    !Array.isArray(m.idf) ||
    !Array.isArray(m.weights) ||
    m.idf.length !== m.vocabulary.length ||
    m.weights.length !== m.vocabulary.length ||
    m.idf.some((v) => !Number.isFinite(v) || v < 1) ||
    m.weights.some((v) => !Number.isFinite(v)) ||
    !Number.isFinite(m.intercept) ||
    !Array.isArray(m.trainHashes) ||
    !Array.isArray(m.validationHashes) ||
    !m.trainHashes.length ||
    !m.validationHashes.length ||
    [...m.trainHashes, ...m.validationHashes].some(
      (h) => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h),
    ) ||
    new Set([...m.trainHashes, ...m.validationHashes]).size !==
      m.trainHashes.length + m.validationHashes.length ||
    !Number.isInteger(m.spamSamples) ||
    m.spamSamples < 20 ||
    !Number.isInteger(m.normalSamples) ||
    m.normalSamples < 20 ||
    m.spamSamples + m.normalSamples !== m.trainHashes.length + m.validationHashes.length ||
    !Number.isInteger(m.iterations) ||
    m.iterations < 1 ||
    m.iterations > 2000 ||
    !m.metrics ||
    ['tp', 'fp', 'tn', 'fn'].some((k) => {
      const v = m.metrics[k as keyof Metrics];
      return !Number.isInteger(v) || v < 0;
    }) ||
    m.metrics.tp + m.metrics.fp + m.metrics.tn + m.metrics.fn !== m.validationHashes.length ||
    ['precision', 'recall', 'f1', 'falsePositiveRate'].some((k) => {
      const v = m.metrics[k as keyof Metrics];
      return !Number.isFinite(v) || v < 0 || v > 1;
    })
  )
    throw new Error('Invalid model artifact');
  return m;
}

export class SpamClassifier {
  private readonly vocabulary: Map<string, number>;
  readonly model: ModelArtifact;
  constructor(input: unknown) {
    this.model = validateModel(input);
    this.vocabulary = new Map(this.model.vocabulary.map((term, i) => [term, i]));
  }
  classify(rawText: string): number | null {
    const text = normalizeMessage(rawText).normalizedText;
    if (text.length > 16_384) return null;
    const vector = vectorize(text, this.vocabulary, this.model.idf);
    // Empty/out-of-vocabulary messages are not evidence of either class.
    return vector.length ? probability(vector, this.model.weights, this.model.intercept) : null;
  }
}
