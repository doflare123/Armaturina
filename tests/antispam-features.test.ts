import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Entity,
  NUMERIC_FEATURES,
  numericFeatures,
  scaledNumeric,
  wordCounts,
} from '../src/antispam/features.ts';
import {
  combinedVector,
  probability,
  type Sample,
  SpamClassifier,
  validateModel,
} from '../src/antispam/model.ts';
import { normalizeMessage } from '../src/antispam/normalizer.ts';
import { SpamStore } from '../src/antispam/store.ts';
import { trainModel } from '../src/antispam/training.ts';

const samples: Sample[] = Array.from({ length: 250 }, (_, i) => {
  const raw = i < 50 ? `КУПИ СЕЙЧАС акция заработок ${i}` : `друзья обсуждают проект спасибо ${i}`;
  const n = normalizeMessage(raw);
  return {
    raw_text: raw,
    normalized_text: n.normalizedText,
    reduced_text: n.reducedText,
    text_hash: n.textHash,
    label: i < 50 ? 1 : 0,
  };
});
const model = trainModel(samples);

test('word unigrams/bigrams retain short Russian words and placeholder tokens', () => {
  const words = wordCounts('Пиши мне в лс <URL>');
  assert.equal(words.get('в'), 1);
  assert.equal(words.get('в лс'), 1);
  assert.equal(words.get('лс <url>'), 1);
  assert.equal(words.get('пиши мне'), 1);
  assert.equal(wordCounts('да да').get('да'), 2);
  assert.equal(wordCounts('😊').size, 0);
});

test('numeric features use raw text, Unicode and bounded fixed scaling', () => {
  assert.deepEqual(
    numericFeatures(''),
    NUMERIC_FEATURES.map(() => 0),
  );
  const raw = 'ААА 123\n😊';
  const f = Object.fromEntries(NUMERIC_FEATURES.map((name, i) => [name, numericFeatures(raw)[i]]));
  assert.equal(f.message_length, 9);
  assert.equal(f.uppercase_ratio, 3 / 9);
  assert.equal(f.digit_ratio, 3 / 9);
  assert.equal(f.repeated_character_score, 3 / 9);
  assert.equal(f.emoji_count, 1);
  assert.equal(f.newline_count, 1);
  assert.ok(scaledNumeric('X'.repeat(100000)).every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  assert.equal(numericFeatures('+7 (999) 123-45-67')[12], 1);
});

test('visible URL entities deduplicate while hidden URLs and mentions use UTF-16 offsets', () => {
  const raw = '😊 https://t.me/test сайт @hello';
  const entities: Entity[] = [
    { type: 'url', offset: 3, length: 17 },
    { type: 'text_link', offset: 21, length: 4, url: 'https://t.me.evil.example' },
    { type: 'mention', offset: 26, length: 6 },
  ];
  const f = numericFeatures(raw, entities);
  assert.equal(f[8], 2);
  assert.equal(f[9], 1);
  assert.equal(f[10], 1);
  assert.equal(f[11], 1);
  assert.equal(
    numericFeatures('link', [
      { type: 'text_link', offset: -1, length: 4, url: 'https://x.test' },
    ])[8],
    0,
  );
});

test('word vocabulary/IDF fits train only; combined vectors are bounded and shared by inference', () => {
  assert.equal(model.format, 3);
  const train = samples.filter((s) => model.trainHashes.includes(s.text_hash));
  model.wordVocabulary?.forEach((term, i) => {
    const df = train.filter((s) => wordCounts(s.normalized_text).has(term)).length;
    assert.ok(df >= 2);
    assert.ok(
      Math.abs((model.wordIdf?.[i] ?? 0) - (Math.log((train.length + 1) / (df + 1)) + 1)) < 1e-12,
    );
  });
  const raw = 'КУПИ СЕЙЧАС акция ссылка',
    entities: Entity[] = [{ type: 'text_link', offset: 17, length: 6, url: 'https://x.test' }];
  const vector = combinedVector(
    normalizeMessage(raw).normalizedText,
    raw,
    entities,
    new Map(model.vocabulary.map((t, i) => [t, i])),
    model.idf,
    new Map(model.wordVocabulary?.map((t, i) => [t, i])),
    model.wordIdf ?? [],
  );
  assert.ok(vector.reduce((sum, [, v]) => sum + v * v, 0) <= 1 + 1e-12);
  assert.equal(
    new SpamClassifier(model).classify(raw, entities),
    probability(vector, model.weights, model.intercept),
  );
});

test('legacy models remain char-only; new models use hidden URL signal and reject corrupt schemas', () => {
  const legacy = {
    ...model,
    format: 1 as const,
    weights: model.vocabulary.map(() => 0),
    intercept: 0,
  };
  assert.equal(new SpamClassifier(legacy).classify('КУПИ'), 0.5);
  assert.equal(new SpamClassifier(legacy).classify('🦊🦊🦊'), null);
  const weights = model.weights.map(() => 0);
  weights[model.vocabulary.length + (model.wordVocabulary?.length ?? 0) + 8] = 12;
  const classifier = new SpamClassifier({ ...model, weights, intercept: 0 });
  assert.ok(
    (classifier.classify('сайт', [
      { type: 'text_link', offset: 0, length: 4, url: 'https://x.test' },
    ]) ?? 0) > (classifier.classify('сайт') ?? 1),
  );
  for (const bad of [
    { ...model, wordIdf: [NaN] },
    { ...model, numericFeatures: [] },
    { ...model, weights: legacy.weights },
    { ...model, wordVocabulary: ['x', 'x'] },
  ])
    assert.throws(() => validateModel(bad));
});

test('dataset supplies a coherent trusted raw snapshot, not normalized text or unlabelled metadata', () => {
  const db = new SpamStore(':memory:');
  try {
    db.importBootstrap(-12, [{ text: 'КУПИ СЕЙЧАС https://x.test', label: 'spam' }]);
    const row = db.dataset(-12)[0];
    assert.ok(row);
    assert.equal(row.raw_text, 'КУПИ СЕЙЧАС https://x.test');
    assert.equal(row.normalized_text, 'купи сейчас <URL>');
    assert.ok((numericFeatures(row.raw_text)[3] ?? 0) > 0);
  } finally {
    db.close();
  }
});
