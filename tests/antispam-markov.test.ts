import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  combineScores,
  MarkovSignal,
  trainMarkov,
  validateMarkov,
} from '../src/antispam/markov.ts';
import { SpamClassifier } from '../src/antispam/model.ts';
import { normalizeMessage } from '../src/antispam/normalizer.ts';
import { measure, splitDataset, trainModel } from '../src/antispam/training.ts';

test('Markov additive smoothing, mean log likelihood, short and unknown text', () => {
  const artifact = trainMarkov([
    { normalized_text: 'aaaaa', label: 1 },
    { normalized_text: 'bbbbb', label: 0 },
  ]);
  const model = new MarkovSignal(artifact);
  // P(a|aaa,spam)=3/5; P(a|aaa,normal)=1/3. sigmoid(log(1.8))=9/14.
  assert.ok(Math.abs((model.score('aaaa') ?? 0) - 9 / 14) < 1e-12);
  assert.ok(Math.abs((model.score('aaaa') ?? 0) - (model.score('aaaaaaaaaaaa') ?? 0)) < 1e-12);
  assert.ok((model.score('bbbb') ?? 1) < 0.5);
  assert.equal(model.score(''), null);
  assert.equal(model.score('aaa'), null);
  assert.equal(model.score('未知😊🦊'), 0.5);
  assert.equal(
    new MarkovSignal(JSON.parse(JSON.stringify(artifact))).score('aaaa'),
    model.score('aaaa'),
  );
});

test('Markov handles Unicode transitions and rejects malformed/corrupt artifacts', () => {
  const artifact = trainMarkov([
    { normalized_text: '😊абв😊абв', label: 1 },
    { normalized_text: 'hello', label: 0 },
  ]);
  assert.ok(Number.isFinite(new MarkovSignal(artifact).score('😊абв')));
  for (const bad of [
    null,
    { ...artifact, alpha: 0 },
    { ...artifact, weight: 1 },
    { ...artifact, spam: [['abc', 'x', -1]] },
    { ...artifact, spam: [...artifact.spam, ...artifact.spam] },
  ]) {
    assert.throws(() => validateMarkov(bad));
  }
  assert.equal(combineScores(null, 1), null);
  assert.equal(combineScores(0.8, null), 0.8);
  assert.ok(Math.abs((combineScores(0.8, 0.3) ?? 0) - 0.75) < 1e-12);
});

test('Markov fits only train; final validation matches inference; legacy models retain their scores', () => {
  const samples = Array.from({ length: 250 }, (_, i) => {
    const text = normalizeMessage(
      i < 50 ? `купи реклама деньги скидка ${i}` : `спасибо друзья проект встреча ${i}`,
    );
    return {
      normalized_text: text.normalizedText,
      reduced_text: text.reducedText,
      text_hash: text.textHash,
      label: i < 50 ? 1 : 0,
    };
  });
  const artifact = trainModel(samples),
    split = splitDataset(samples);
  assert.equal(artifact.format, 3);
  assert.deepEqual(artifact.markov, trainMarkov(split.train));
  const model = new SpamClassifier(artifact);
  const results = split.validation.map((s) => model.assess(s.normalized_text));
  assert.deepEqual(
    artifact.metrics,
    measure(
      split.validation.map((s) => s.label),
      results.map((r) => r.finalScore ?? 0),
    ),
  );
  const result = model.assess('купи реклама деньги');
  assert.ok(result.markovScore !== null);
  assert.equal(result.finalScore, combineScores(result.classifierScore, result.markovScore));
  const legacy = new SpamClassifier({ ...artifact, format: 2, markov: undefined });
  assert.equal(
    legacy.assess('купи реклама деньги').finalScore,
    legacy.classify('купи реклама деньги'),
  );
  assert.equal(legacy.assess('купи реклама деньги').markovScore, null);
  assert.throws(() => new SpamClassifier({ ...artifact, markov: undefined }));
});
