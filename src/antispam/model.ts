import { type Entity, NUMERIC_FEATURES, scaledNumeric, wordCounts } from './features.ts';
import { combineScores, type MarkovArtifact, MarkovSignal, validateMarkov } from './markov.ts';
import { normalizeMessage } from './normalizer.ts';

export interface Sample {
  text_hash: string;
  normalized_text: string;
  reduced_text: string;
  label: number;
  duplicate_count?: number;
  raw_text?: string;
  metadata?: string;
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
  format: 1 | 2 | 3;
  markov?: MarkovArtifact;
  wordVocabulary?: string[];
  wordIdf?: number[];
  numericFeatures?: string[];
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
  counts = charCounts(text),
): SparseVector {
  const vector: SparseVector = [];
  let norm = 0;
  for (const [term, count] of counts) {
    const index = vocabulary.get(term);
    if (index === undefined) continue;
    const value = (1 + Math.log(count)) * (idf[index] ?? 0);
    vector.push([index, value]);
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  return norm ? vector.map(([i, value]) => [i, value / norm]) : [];
}

export function combinedVector(
  text: string,
  raw: string,
  entities: readonly Entity[],
  vocabulary: ReadonlyMap<string, number>,
  idf: number[],
  words: ReadonlyMap<string, number>,
  wordIdf: number[],
): SparseVector {
  const char = vectorize(text, vocabulary, idf);
  const word = vectorize(text, words, wordIdf, wordCounts(text));
  const numeric = scaledNumeric(raw, entities);
  return [
    ...char.map(([i, v]): [number, number] => [i, v / Math.sqrt(3)]),
    ...word.map(([i, v]): [number, number] => [vocabulary.size + i, v / Math.sqrt(3)]),
    ...numeric.map((v, i): [number, number] => [
      vocabulary.size + words.size + i,
      v / Math.sqrt(3 * numeric.length),
    ]),
  ].filter(([, v]) => v !== 0);
}

export function sampleEntities(sample: Sample): Entity[] {
  const entities = sample.metadata ? JSON.parse(sample.metadata).entities : [];
  return Array.isArray(entities) ? entities : [];
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
    (m?.format !== 1 && m?.format !== 2 && m?.format !== 3) ||
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
    m.weights.length !==
      m.vocabulary.length +
        (m.format !== 1 ? (m.wordVocabulary?.length ?? 0) + NUMERIC_FEATURES.length : 0) ||
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
  if (
    m.format !== 1 &&
    (!Array.isArray(m.wordVocabulary) ||
      m.wordVocabulary.length > 10000 ||
      m.wordVocabulary.some((t) => typeof t !== 'string' || !t.length || t.length > 32769) ||
      new Set(m.wordVocabulary).size !== m.wordVocabulary.length ||
      !Array.isArray(m.wordIdf) ||
      m.wordIdf.length !== m.wordVocabulary.length ||
      m.wordIdf.some((v) => !Number.isFinite(v) || v < 1) ||
      JSON.stringify(m.numericFeatures) !== JSON.stringify(NUMERIC_FEATURES))
  )
    throw new Error('Invalid feature schema');
  if (m.format === 3) validateMarkov(m.markov);
  return m;
}

export class SpamClassifier {
  private readonly vocabulary: Map<string, number>;
  private readonly words: Map<string, number>;
  private readonly markov: MarkovSignal | null;
  readonly model: ModelArtifact;
  constructor(input: unknown) {
    this.model = validateModel(input);
    this.vocabulary = new Map(this.model.vocabulary.map((term, i) => [term, i]));
    this.words = new Map((this.model.wordVocabulary ?? []).map((term, i) => [term, i]));
    this.markov = this.model.format === 3 ? new MarkovSignal(this.model.markov) : null;
  }
  classify(rawText: string, entities: readonly Entity[] = []): number | null {
    const text = normalizeMessage(rawText).normalizedText;
    if (!text.trim() || rawText.length > 16_384 || text.length > 16_384) return null;
    const vector =
      this.model.format !== 1
        ? combinedVector(
            text,
            rawText,
            entities,
            this.vocabulary,
            this.model.idf,
            this.words,
            this.model.wordIdf ?? [],
          )
        : vectorize(text, this.vocabulary, this.model.idf);
    // Legacy models abstain on OOV; format 2 can still use numeric evidence.
    return vector.length ? probability(vector, this.model.weights, this.model.intercept) : null;
  }

  assess(rawText: string, entities: readonly Entity[] = []) {
    const classifierScore = this.classify(rawText, entities);
    const markovScore =
      classifierScore === null
        ? null
        : (this.markov?.score(normalizeMessage(rawText).normalizedText) ?? null);
    return {
      classifierScore,
      markovScore,
      finalScore: combineScores(classifierScore, markovScore),
    };
  }
}
