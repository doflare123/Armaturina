import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { decide } from '../src/antispam/decision.ts';
import { LearningService } from '../src/antispam/learning.ts';
import {
  charCounts,
  type Sample,
  SpamClassifier,
  sigmoid,
  validateModel,
  vectorize,
} from '../src/antispam/model.ts';
import { normalizeMessage } from '../src/antispam/normalizer.ts';
import { SpamStore } from '../src/antispam/store.ts';
import { SpamTelegram } from '../src/antispam/telegram.ts';
import { measure, splitDataset, trainModel } from '../src/antispam/training.ts';

function samples(): Sample[] {
  return Array.from({ length: 250 }, (_, i) => {
    const text = normalizeMessage(
      i < 50
        ? `Заработок деньги реклама купи сейчас акция ${i}`
        : `Обсуждаем проект встреча завтра спасибо друзья ${i}`,
    );
    return {
      text_hash: text.textHash,
      normalized_text: text.normalizedText,
      reduced_text: text.reducedText,
      label: i < 50 ? 1 : 0,
    };
  });
}
const dataset = samples();
const model = trainModel(dataset);

test('TF-IDF uses 3–5 code points, sublinear TF, smoothed IDF and L2 normalization', () => {
  assert.deepEqual(
    [...charCounts('абвг')],
    [
      ['абв', 1],
      ['бвг', 1],
      ['абвг', 1],
    ],
  );
  assert.equal(charCounts('❤️a😊').has('️a😊'), true);
  const vector = vectorize(
    'aaaaab',
    new Map([
      ['aaa', 0],
      ['aab', 1],
    ]),
    [2, 1],
  );
  const a = 2 * (1 + Math.log(3)),
    norm = Math.hypot(a, 1);
  assert.ok(Math.abs((vector[0]?.[1] ?? 0) - a / norm) < 1e-12);
  assert.ok(Math.abs((vector[1]?.[1] ?? 0) - 1 / norm) < 1e-12);
  assert.deepEqual(vectorize('xy', new Map(), []), []);
  assert.equal(sigmoid(1000), 1);
  assert.equal(sigmoid(-1000), 0);
});

test('deterministic stratification excludes duplicate and repeat-equivalent leakage and conflicts', () => {
  const split = splitDataset(dataset);
  assert.equal(split.train.length, 200);
  assert.equal(split.validation.length, 50);
  assert.deepEqual(splitDataset([...dataset].reverse()), split);
  const keys = new Set(split.train.map((s) => s.reduced_text));
  assert.ok(split.validation.every((s) => !keys.has(s.reduced_text)));
  const first = dataset[0];
  assert.ok(first);
  assert.deepEqual(splitDataset([...dataset, first]), split);
  const equivalent = {
    ...first,
    text_hash: 'a'.repeat(64),
    normalized_text: `${first.normalized_text}ииии`,
    reduced_text: first.reduced_text,
  };
  assert.equal(splitDataset([...dataset, equivalent]).spam, 50);
  assert.equal(splitDataset([...dataset, { ...first, label: 0 }]).spam, 49);
});

test('logistic regression learns both classes; validation vocabulary never fits held-out samples', () => {
  const classifier = new SpamClassifier(model);
  assert.ok((classifier.classify('Заработок деньги реклама купи сейчас акция') ?? 0) > 0.6);
  assert.ok((classifier.classify('Обсуждаем проект встреча завтра спасибо друзья') ?? 1) < 0.4);
  assert.equal(classifier.classify(''), null);
  assert.equal(classifier.classify('🦊🦊🦊'), null);
  const train = dataset.filter((s) => model.trainHashes.includes(s.text_hash));
  model.vocabulary.forEach((term, i) => {
    const df = train.filter((s) => charCounts(s.normalized_text).has(term)).length;
    assert.ok(df >= 2);
    assert.ok(
      Math.abs((model.idf[i] ?? 0) - (Math.log((train.length + 1) / (df + 1)) + 1)) < 1e-12,
    );
  });
  assert.equal(model.metrics.precision, 1);
  assert.equal(model.metrics.recall, 1);
  assert.ok(model.iterations < 2000);
});

test('cold start and corrupt artifacts cannot become live models', () => {
  assert.throws(() => trainModel([]), /COLD_START/);
  assert.throws(() => trainModel(dataset.filter((s) => s.label === 0)), /COLD_START/);
  for (const bad of [
    null,
    {},
    { ...model, normalizerVersion: 2 },
    { ...model, weights: [NaN] },
    { ...model, idf: model.idf.map(() => Infinity) },
    { ...model, validationHashes: model.trainHashes },
  ]) {
    assert.throws(() => validateModel(bad));
  }
});

test('DecisionEngine never deletes, including every threshold boundary and invalid score', () => {
  for (const score of [0, 0.5999, 0.6, 0.9499, 0.95, 0.985, 1]) {
    assert.equal(decide(score).decision, score >= 0.6 ? 'ASK_ADMIN' : 'ALLOW');
    assert.equal(decide(score, true).decision, 'ALLOW');
  }
  for (const score of [NaN, Infinity, -1, 1.1, null]) assert.equal(decide(score).decision, 'ALLOW');
  assert.deepEqual(measure([1, 0, 1, 0], [0.9, 0.8, 0.2, 0.1]), {
    precision: 0.5,
    recall: 0.5,
    f1: 0.5,
    falsePositiveRate: 0.5,
    tp: 1,
    fp: 1,
    tn: 1,
    fn: 1,
  });
});

test('schema v1 migration preserves messages and labels and adds constrained prediction/model contracts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spam-migration-')),
    file = join(dir, 'db.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY, chat_id INTEGER);
    CREATE TABLE labels(id INTEGER PRIMARY KEY, message_id INTEGER, label INTEGER);
    CREATE TABLE moderation_cases(id TEXT PRIMARY KEY, message_id INTEGER);
    INSERT INTO messages VALUES(1,-12); INSERT INTO labels VALUES(1,1,0); PRAGMA user_version=1;`);
  raw.close();
  const store = new SpamStore(file);
  try {
    const inspect = new DatabaseSync(file);
    try {
      assert.equal(inspect.prepare('PRAGMA user_version').get()?.user_version, 2);
      assert.equal(inspect.prepare('SELECT label FROM labels').get()?.label, 0);
      const version = store.activateModel(-12, model, 'snapshot');
      assert.ok(store.prediction(1, version, 0.8, 'ASK_ADMIN', 'test'));
      assert.equal(store.prediction(1, version, 0.8, 'ASK_ADMIN', 'test'), null);
      assert.throws(() => inspect.prepare("UPDATE predictions SET decision='AUTO_DELETE'").run());
      assert.throws(() => inspect.prepare('UPDATE predictions SET classifier_score=2').run());
    } finally {
      inspect.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test('worker training activates atomically, caches inference, rejects overlapping jobs and survives restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spam-worker-')),
    file = join(dir, 'db.sqlite');
  const store = new SpamStore(file),
    learning = new LearningService(store);
  try {
    await assert.rejects(learning.train(-12), /COLD_START/);
    store.importBootstrap(
      -12,
      dataset.map((s) => ({ text: s.normalized_text, label: s.label ? 'spam' : 'normal' })),
    );
    const job = learning.train(-12);
    await assert.rejects(learning.train(-12), /уже выполняется/);
    const version = await job;
    assert.equal(learning.current(-12)?.version, version);
    assert.equal(learning.current(-12), learning.current(-12));
    assert.equal(learning.current(-99), undefined);
    const other = new SpamStore(file),
      reload = new LearningService(other);
    try {
      assert.equal(reload.current(-12)?.version, version);
    } finally {
      reload.close();
      other.close();
    }
    assert.throws(() => store.activateModel(-12, { ...model, intercept: NaN }, 'bad'));
    assert.equal(store.activeModel(-12)?.version, version);
    const next = learning.train(-12);
    store.importBootstrap(-12, [{ text: 'новая разметка после снимка', label: 'normal' }]);
    await assert.rejects(next, /изменилась/);
    assert.equal(store.activeModel(-12)?.version, version);
  } finally {
    learning.close();
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test('automatic suggestions persist predictions without labels or deletion, respect cooldown and admin protection', async () => {
  const sent: string[] = [],
    deleted: number[] = [];
  const api = {
    async getChatMember(_chat: number, id: number) {
      return { status: id === 1 ? 'administrator' : 'member' };
    },
    async sendMessage(_chat: number, text: string) {
      sent.push(text);
      return { message_id: 1000 + sent.length };
    },
    async deleteMessage(_chat: number, id: number) {
      deleted.push(id);
    },
  } as unknown as Api;
  const adapter = new SpamTelegram(api, {
    chatIds: [-12],
    databasePath: ':memory:',
    retentionDays: 180,
  });
  const msg = (id: number, author = 10): Message => ({
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -12, type: 'supergroup', title: 'test' },
    from: { id: author, is_bot: false, first_name: 'test' },
    text: 'Заработок деньги реклама купи сейчас акция',
  });
  try {
    await adapter.message(msg(1), 'bot');
    assert.equal(sent.length, 0);
    adapter.store.activateModel(-12, model, 'snapshot');
    await adapter.message(msg(2, 1), 'bot');
    assert.equal(sent.length, 0);
    await adapter.message(msg(3), 'bot');
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? '', /Возможный спам/);
    await adapter.message(msg(3), 'bot');
    await adapter.message(msg(4), 'bot');
    assert.equal(sent.length, 1);
    assert.deepEqual(deleted, []);
    assert.deepEqual(adapter.store.dataset(-12), []);
    const id = /ID: ([a-f0-9-]+)/.exec(sent[0] ?? '')?.[1];
    assert.ok(id);
    assert.ok(adapter.store.getCase(id));
  } finally {
    adapter.close();
  }
});

test('closing the service cancels training without publishing a late model', async () => {
  const store = new SpamStore(':memory:');
  const learning = new LearningService(store);
  try {
    store.importBootstrap(
      -12,
      dataset.map((s) => ({ text: s.normalized_text, label: s.label ? 'spam' : 'normal' })),
    );
    const job = learning.train(-12);
    learning.close();
    await assert.rejects(job, /stopped|closed/);
    assert.equal(store.activeModel(-12), undefined);
  } finally {
    learning.close();
    store.close();
  }
});
