import { createHash } from 'node:crypto';
import { NUMERIC_FEATURES, wordCounts } from './features.ts';
import {
  charCounts,
  combinedVector,
  type Metrics,
  type ModelArtifact,
  probability,
  type Sample,
  sampleEntities,
} from './model.ts';

export function splitDataset(samples: Sample[]) {
  // Collapse repeat-reduced equivalents too, and discard conflicting labels before splitting.
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    if (
      (sample.label !== 0 && sample.label !== 1) ||
      !sample.normalized_text.trim() ||
      sample.normalized_text.length > 16_384
    )
      continue;
    const key = createHash('sha256').update(sample.reduced_text).digest('hex');
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  const unique = [...groups.values()]
    .filter((g) => g.every((s) => s.label === g[0]?.label))
    .map((g) => g.sort((a, b) => a.text_hash.localeCompare(b.text_hash))[0])
    .filter((s): s is Sample => !!s)
    .sort((a, b) => a.text_hash.localeCompare(b.text_hash));
  const train: Sample[] = [],
    validation: Sample[] = [];
  for (const label of [0, 1]) {
    const items = unique.filter((s) => s.label === label);
    const count = Math.max(1, Math.floor(items.length * 0.2));
    validation.push(...items.slice(0, count));
    train.push(...items.slice(count));
  }
  return {
    train,
    validation,
    spam: unique.filter((s) => s.label === 1).length,
    normal: unique.filter((s) => s.label === 0).length,
  };
}

export function measure(labels: number[], scores: number[], threshold = 0.6): Metrics {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  labels.forEach((label, i) => {
    if ((scores[i] ?? 0) >= threshold) {
      if (label === 1) tp++;
      else fp++;
    } else {
      if (label === 1) fn++;
      else tn++;
    }
  });
  const precision = tp + fp ? tp / (tp + fp) : 0,
    recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    falsePositiveRate: fp + tn ? fp / (fp + tn) : 0,
    tp,
    fp,
    tn,
    fn,
  };
}

/** Batch gradient descent for balanced binary logistic loss with L2, C=1.
 * L2-normalized rows bound curvature; step=1 is conservative. Bias is not penalized.
 * Runs only in a worker. Vocabulary and IDF are fitted strictly on train rows.
 */
export function trainModel(samples: Sample[], minSpam = 50, minNormal = 200): ModelArtifact {
  if (samples.length > 10_000) throw new Error('Dataset exceeds 10000 samples');
  const { train, validation, spam, normal } = splitDataset(samples);
  if (spam < minSpam || normal < minNormal || spam < 20 || normal < 20) {
    throw new Error(
      `COLD_START: spam ${spam}/${Math.max(20, minSpam)}, normal ${normal}/${Math.max(20, minNormal)}`,
    );
  }
  const df = new Map<string, number>();
  for (const sample of train)
    for (const term of charCounts(sample.normalized_text).keys())
      df.set(term, (df.get(term) ?? 0) + 1);
  const vocabulary = [...df]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30_000)
    .map(([term]) => term);
  if (!vocabulary.length) throw new Error('No shared character n-grams');
  const index = new Map(vocabulary.map((term, i) => [term, i]));
  const idf = vocabulary.map(
    (term) => Math.log((train.length + 1) / ((df.get(term) ?? 0) + 1)) + 1,
  );
  const wordDf = new Map<string, number>();
  for (const s of train)
    for (const term of wordCounts(s.normalized_text).keys())
      wordDf.set(term, (wordDf.get(term) ?? 0) + 1);
  const wordVocabulary = [...wordDf]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10000)
    .map(([term]) => term);
  const wordIdf = wordVocabulary.map(
    (term) => Math.log((train.length + 1) / ((wordDf.get(term) ?? 0) + 1)) + 1,
  );
  const wordIndex = new Map(wordVocabulary.map((term, i) => [term, i]));
  const features = (s: Sample) =>
    combinedVector(
      s.normalized_text,
      s.raw_text ?? s.normalized_text,
      sampleEntities(s),
      index,
      idf,
      wordIndex,
      wordIdf,
    );
  const vectors = train.map(features);
  const weights = new Float64Array(
      vocabulary.length + wordVocabulary.length + NUMERIC_FEATURES.length,
    ),
    gradient = new Float64Array(weights.length);
  const positives = train.filter((s) => s.label === 1).length;
  const classWeights = [
    train.length / (2 * (train.length - positives)),
    train.length / (2 * positives),
  ];
  let intercept = 0,
    iterations = 0,
    converged = false;
  for (; iterations < 2000; iterations++) {
    gradient.set(weights); // derivative of .5 * ||w||² / N
    let biasGradient = 0;
    vectors.forEach((vector, i) => {
      const label = train[i]?.label ?? 0;
      const error = (probability(vector, weights, intercept) - label) * (classWeights[label] ?? 1);
      biasGradient += error;
      for (const [j, x] of vector) gradient[j] = (gradient[j] ?? 0) + error * x;
    });
    let maxGradient = Math.abs(biasGradient / train.length);
    for (let j = 0; j < weights.length; j++) {
      const step = (gradient[j] ?? 0) / train.length;
      weights[j] = (weights[j] ?? 0) - step;
      maxGradient = Math.max(maxGradient, Math.abs(step));
    }
    intercept -= biasGradient / train.length;
    if (maxGradient < 1e-4) {
      converged = true;
      break;
    }
  }
  if (!converged) throw new Error('Training did not converge; previous model retained');
  const scores = validation.map((s) => {
    const vector = features(s);
    return vector.length ? probability(vector, weights, intercept) : 0;
  });
  return {
    format: 2,
    wordVocabulary,
    wordIdf,
    numericFeatures: [...NUMERIC_FEATURES],
    normalizerVersion: 1,
    vocabulary,
    idf,
    weights: Array.from(weights),
    intercept,
    metrics: measure(
      validation.map((s) => s.label),
      scores,
    ),
    trainHashes: train.map((s) => s.text_hash),
    validationHashes: validation.map((s) => s.text_hash),
    spamSamples: spam,
    normalSamples: normal,
    iterations: iterations + 1,
  };
}
