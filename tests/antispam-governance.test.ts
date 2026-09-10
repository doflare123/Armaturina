import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import {
  calibrate,
  type EvaluationRow,
  evaluationGroups,
  quality,
} from '../src/antispam/governance.ts';
import { LearningService } from '../src/antispam/learning.ts';
import { normalizeMessage } from '../src/antispam/normalizer.ts';
import { SpamStore } from '../src/antispam/store.ts';
import { SpamTelegram } from '../src/antispam/telegram.ts';
import { trainModel } from '../src/antispam/training.ts';

const samples = Array.from({ length: 250 }, (_, i) => {
  const n = normalizeMessage(
    i < 50
      ? `Заработок реклама купи деньги акция ${i}`
      : `Обсуждаем проект друзья встреча спасибо ${i}`,
  );
  return {
    text_hash: n.textHash,
    normalized_text: n.normalizedText,
    reduced_text: n.reducedText,
    label: i < 50 ? 1 : 0,
  };
});
const model = trainModel(samples);
function message(
  id: number,
  text = 'Заработок реклама купи деньги акция новинка',
  user = 10,
): Message {
  return {
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -12, type: 'supergroup', title: 'test' },
    from: { id: user, is_bot: false, first_name: 'user' },
    text,
  };
}
function rows(): EvaluationRow[] {
  return Array.from({ length: 100 }, (_, id) => ({
    id,
    score: id % 2 ? 0.9 : 0.1,
    label: id % 2,
    text_hash: `hash${id}`,
    reduced_text: `text${id}`,
    created_at: id,
    mode: 'SHADOW',
    threshold: 0.6,
  }));
}

test('calibration separates temporal holdout, groups duplicates, abstains without support', () => {
  const input = rows(),
    baseline = calibrate(input);
  assert.equal(baseline.threshold, 0.9);
  assert.equal(baseline.holdout.precision, 1);
  assert.deepEqual(calibrate([...input, ...input]), baseline);
  const changed = input.map((r) => (r.id >= 60 ? { ...r, score: 1 - r.score } : r));
  const degraded = calibrate(changed);
  assert.equal(degraded.threshold, baseline.threshold);
  assert.equal(degraded.holdout.precision, 0);
  assert.equal(degraded.accepted, false);
  assert.equal(baseline.accepted, true);
  assert.equal(
    evaluationGroups([...input, { ...input[0], id: 101, label: 1 } as EvaluationRow]).length,
    99,
  );
  assert.throws(() => calibrate(input.slice(0, 20)), /Недостаточно/);
  assert.throws(() => calibrate(input.map((r) => ({ ...r, score: 0.5 }))), /Нет порога/);
  assert.equal(quality([], 0.6).precision, null);
});

test('SHADOW logs counterfactual decisions and policy, manual review works, modes are admin-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spam-shadow-')),
    file = join(dir, 'db.sqlite'),
    sent: string[] = [];
  const api = {
    getChatMember: async (_: number, id: number) => ({
      status: id === 1 ? 'administrator' : 'member',
    }),
    sendMessage: async (_: number, text: string) => {
      sent.push(text);
      return { message_id: 100 + sent.length };
    },
    deleteMessage: async () => assert.fail('No deletion in shadow inference'),
  } as unknown as Api;
  const bot = new SpamTelegram(api, { databasePath: file, chatIds: [-12], retentionDays: 180 });
  try {
    const version = bot.store.activateModel(-12, model, 'test');
    await bot.message(message(1, '/spam mode SHADOW', 1), 'bot');
    sent.length = 0;
    await bot.message(message(2), 'bot');
    assert.equal(sent.length, 0);
    const db = new DatabaseSync(file);
    try {
      assert.equal(db.prepare('SELECT decision FROM predictions').get()?.decision, 'ASK_ADMIN');
      assert.deepEqual(
        { ...db.prepare('SELECT mode,threshold FROM prediction_policy').get() },
        { mode: 'SHADOW', threshold: 0.6 },
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM moderation_cases').get()?.n, 0);
    } finally {
      db.close();
    }
    await bot.message(message(3, '/spam mode LEARNING', 10), 'bot');
    assert.equal(bot.store.governance.policy(-12, version).mode, 'SHADOW');
    await bot.message(
      {
        ...message(4, '/spam review', 1),
        reply_to_message: { ...message(2), reply_to_message: undefined },
      },
      'bot',
    );
    assert.ok(sent.some((s) => s.includes('Ручная разметка')));
    await bot.message(message(5, '/spam mode LEARNING', 1), 'bot');
    sent.length = 0;
    await bot.message(message(6), 'bot');
    assert.equal(sent.length, 1);
    assert.equal(bot.store.governance.policy(-99, version).mode, 'LEARNING');
  } finally {
    bot.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback restores model and its threshold immediately and after restart; rejects other chats/corruption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spam-rollback-')),
    file = join(dir, 'db.sqlite');
  let store = new SpamStore(file),
    learning = new LearningService(store);
  try {
    const first = store.activateModel(-12, model, 'first');
    store.governance.setThreshold(-12, first, 0.85, 1);
    const second = store.activateModel(-12, { ...model, intercept: model.intercept + 1 }, 'second');
    assert.equal(learning.current(-12)?.version, second);
    store.governance.setMode(-12, 'SHADOW', 1);
    store.rollback(-12, first, 1);
    assert.equal(learning.current(-12)?.version, first);
    assert.deepEqual(store.governance.policy(-12, first), { mode: 'SHADOW', threshold: 0.85 });
    assert.throws(() => store.rollback(-99, second, 1));
    assert.throws(() => store.governance.setThreshold(-12, second, 0.1, 1));
    for (const n of [NaN, 0, 1.1])
      assert.throws(() => store.governance.setThreshold(-12, first, n, 1));
    const db = new DatabaseSync(file);
    db.prepare('UPDATE model_versions SET artifact_json=? WHERE version=?').run('{}', second);
    db.close();
    assert.throws(() => store.rollback(-12, second, 1));
    assert.equal(store.activeModel(-12)?.version, first);
    learning.close();
    store.close();
    store = new SpamStore(file);
    learning = new LearningService(store);
    assert.equal(learning.current(-12)?.version, first);
    assert.equal(store.governance.policy(-12, first).threshold, 0.85);
  } finally {
    learning.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics use prospective human labels, exclude training data, and undo removes evidence', async () => {
  const bot = new SpamTelegram(
    { getChatMember: async () => ({ status: 'member' }) } as unknown as Api,
    { databasePath: ':memory:', chatIds: [-12], retentionDays: 180 },
  );
  try {
    const version = bot.store.activateModel(-12, model, 'test');
    bot.store.governance.setMode(-12, 'SHADOW', 1);
    await bot.message(message(1), 'bot');
    await bot.message(message(2, samples[0]?.normalized_text), 'bot');
    const excluded = [...model.trainHashes, ...model.validationHashes];
    let eligible = bot.store.governance.rows(-12, version, excluded);
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0]?.label, null);
    const id = bot.store.capture(message(1));
    assert.ok(id);
    const item = bot.store.createCase(id);
    bot.store.resolve(item.id, 1, 'spam');
    eligible = bot.store.governance.rows(-12, version, excluded);
    assert.equal(evaluationGroups(eligible).length, 1);
    bot.store.undo(item.id, 1);
    assert.equal(evaluationGroups(bot.store.governance.rows(-12, version, excluded)).length, 0);
    assert.equal(bot.store.governance.rows(-99, version, excluded).length, 0);
  } finally {
    bot.close();
  }
});

test('a rollback during worker training cannot be overwritten by its late result', async () => {
  const store = new SpamStore(':memory:'),
    learning = new LearningService(store);
  try {
    store.importBootstrap(
      -12,
      samples.map((s) => ({ text: s.normalized_text, label: s.label ? 'spam' : 'normal' })),
    );
    const first = store.activateModel(-12, model, 'first');
    store.activateModel(-12, model, 'second');
    const pending = learning.train(-12);
    store.rollback(-12, first, 1);
    await assert.rejects(pending, /изменились/);
    assert.equal(store.activeModel(-12)?.version, first);
  } finally {
    learning.close();
    store.close();
  }
});
