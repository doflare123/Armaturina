import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { decide } from '../src/antispam/decision.ts';
import { charCounts, type ModelArtifact, SpamClassifier } from '../src/antispam/model.ts';
import { normalizeMessage } from '../src/antispam/normalizer.ts';
import {
  ContextSignals,
  contextualScore,
  messageUrls,
  type SignalContext,
} from '../src/antispam/signals.ts';
import { SpamStore } from '../src/antispam/store.ts';
import { SpamTelegram } from '../src/antispam/telegram.ts';

const spam = 'Заработок деньги реклама купи сейчас акция';
const normal = 'Обсуждаем проект встреча завтра спасибо друзья';
const vocabulary = [
  ...charCounts(normalizeMessage(`${spam} ${normal} https://example.com`).normalizedText).keys(),
];
const artifact: ModelArtifact = {
  format: 1,
  normalizerVersion: 1,
  vocabulary,
  idf: vocabulary.map(() => 1),
  weights: vocabulary.map(() => 0),
  intercept: Math.log(0.55 / 0.45),
  metrics: { precision: 0, recall: 0, f1: 0, falsePositiveRate: 0, tp: 0, fp: 0, tn: 5, fn: 5 },
  trainHashes: Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(64, '0')),
  validationHashes: Array.from({ length: 10 }, (_, i) => (i + 30).toString(16).padStart(64, '0')),
  spamSamples: 20,
  normalSamples: 20,
  iterations: 1,
};
const now = Math.floor(Date.now() / 1000) * 1000;
function message(id = 1, user = 10, chat = -12, text = spam): Message {
  return {
    message_id: id,
    date: now / 1000,
    chat: { id: chat, type: 'supergroup', title: 'test' },
    from: { id: user, is_bot: false, first_name: 'User' },
    text,
  };
}
function context(): SignalContext {
  return {
    observed: 1,
    last60s: 1,
    last10m: 1,
    joinedAt: null,
    sinceJoin: null,
    recent: [],
    references: [],
  };
}
function engine() {
  return new ContextSignals(new SpamClassifier(artifact));
}

test('cosine uses confirmed references, abstains on short/OOV/long text and normal match cancels boost', () => {
  const ctx = context();
  ctx.references = [{ id: 1, normalized_text: normalizeMessage(spam).normalizedText, label: 1 }];
  const signals = engine().assess(spam, [], 10, now, ctx);
  assert.ok((signals.spamSimilarity ?? 0) > 0.999);
  assert.equal(signals.spamReferenceId, 1);
  assert.equal(decide(contextualScore(0.55, signals)).decision, 'ASK_ADMIN');
  assert.equal(contextualScore(null, signals), null);
  for (const raw of ['Привет', '陌生文本'.repeat(10), 'а'.repeat(5000)])
    assert.equal(engine().assess(raw, [], 10, now, ctx).spamSimilarity, null);
  ctx.references.push({ normalized_text: normalizeMessage(spam).normalizedText, id: 2, label: 0 });
  const balanced = engine().assess(spam, [], 10, now, ctx);
  assert.ok((contextualScore(0.55, balanced) ?? 1) < 0.6);
  assert.equal(decide(contextualScore(0.99, signals), true).decision, 'ALLOW');
});

test('campaigns count distinct other users within ten minutes; own repeats remain behavior evidence', () => {
  const ctx = context();
  const n = normalizeMessage(spam);
  const recent = (id: number, user: number, age = 0) => ({
    id,
    user_id: user,
    changed_at: now - age,
    normalized_text: n.normalizedText,
    text_hash: n.textHash,
    raw_text: spam,
    metadata: '{}',
  });
  ctx.recent = [recent(1, 10), recent(2, 11), recent(3, 11), recent(4, 12, 600001)];
  let signals = engine().assess(spam, [], 10, now, ctx);
  assert.equal(signals.campaignUsers, 2);
  assert.equal(signals.campaignScore, 0.3);
  assert.equal(signals.duplicatesLastHour, 1);
  ctx.recent.push(recent(5, 12), recent(6, 13), recent(7, 14));
  signals = engine().assess(spam, [], 10, now, ctx);
  assert.equal(signals.campaignUsers, 5);
  assert.equal(signals.campaignScore, 1);
});

test('URLs preserve destination, include hidden entities and never equate different <URL> placeholders', () => {
  assert.deepEqual(
    [
      ...messageUrls('тут', [
        { type: 'text_link', offset: 0, length: 3, url: 'https://EXAMPLE.com/a#part' },
      ]),
    ],
    ['https://example.com/a'],
  );
  assert.equal(
    messageUrls('тут', [{ type: 'text_link', offset: 4, length: 3, url: 'https://example.com' }])
      .size,
    0,
  );
  const ctx = context();
  ctx.recent = [
    {
      id: 1,
      user_id: 11,
      changed_at: now,
      raw_text: 'тут',
      metadata: JSON.stringify({
        entities: [{ type: 'text_link', offset: 0, length: 3, url: 'https://example.com/a' }],
      }),
      normalized_text: 'тут',
      text_hash: 'x',
    },
  ];
  assert.equal(engine().assess('https://example.com/a', [], 10, now, ctx).sameUrlOtherUsers, 1);
  assert.equal(engine().assess('https://example.com/b', [], 10, now, ctx).sameUrlOtherUsers, 0);
});

test('live observation is isolated, idempotent across edits, excludes manual capture and persists joins', () => {
  const store = new SpamStore(':memory:');
  try {
    const observe = (m: Message, update = 1) => {
      const id = store.capture(m, update);
      assert.ok(id);
      store.observe(m, id);
      return id;
    };
    store.capture(message(99)); // Manual review does not count as live traffic.
    observe(message());
    observe(message());
    observe({ ...message(), edit_date: now / 1000 + 1, text: normal }, 2);
    observe(message(2, 11));
    observe(message(3, 10, -99));
    let ctx = store.signalContext(-12, 10, 1, now + 1000);
    assert.equal(ctx.observed, 1);
    assert.equal(ctx.last60s, 1);
    assert.equal(ctx.joinedAt, null);
    assert.equal(ctx.sinceJoin, null);
    assert.deepEqual(
      ctx.recent.map((r) => r.user_id),
      [11],
    );
    const joiningUser = message().from;
    assert.ok(joiningUser);
    store.observeJoins({
      ...message(4),
      date: now / 1000 - 30,
      new_chat_members: [joiningUser],
    });
    ctx = store.signalContext(-12, 10, 1, now + 1000);
    assert.equal(ctx.sinceJoin, 1);
    assert.equal(ctx.joinedAt, now - 30000);
    assert.equal(store.signalContext(-99, 10, 3, now + 1000).joinedAt, null);
    assert.equal(store.signalContext(-12, 10, 1, now + 3_601_000).recent.length, 0);
    assert.deepEqual(store.dataset(-12), []);
  } finally {
    store.close();
  }
});

test('reference lookup excludes own revisions, conflicting labels, other chats and undone feedback', () => {
  const store = new SpamStore(':memory:');
  try {
    const label = (m: Message, verdict: 'spam' | 'normal') => {
      const id = store.capture(m);
      assert.ok(id);
      const item = store.createCase(id);
      assert.ok(store.resolve(item.id, 1, verdict));
      return item;
    };
    const first = label(message(), 'spam');
    const inspect = (source = 99) =>
      store.signalContext(-12, 10, source, Date.now() + 1000).references;
    assert.equal(inspect(1).length, 0);
    assert.equal(inspect().length, 1);
    const conflict = label(message(2), 'normal');
    assert.equal(inspect().length, 0);
    store.undo(conflict.id, 1);
    assert.equal(inspect().length, 1);
    label(message(3, 10, -99, normal), 'normal');
    assert.equal(inspect().length, 1);
    store.undo(first.id, 1);
    assert.equal(inspect().length, 0);
  } finally {
    store.close();
  }
});

test('v5 migration and restart preserve observations; pruning cascades signal history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spam-signals-')),
    file = join(dir, 'db.sqlite');
  let store = new SpamStore(file);
  store.close();
  const old = new DatabaseSync(file);
  old.exec(
    'DROP TABLE prediction_signals; DROP TABLE observed_messages; DROP TABLE observed_joins; PRAGMA user_version=5;',
  );
  old.close();
  try {
    store = new SpamStore(file);
    const m = message(),
      id = store.capture(m);
    assert.ok(id);
    store.observe(m, id);
    assert.ok(m.from);
    store.observeJoins({ ...m, new_chat_members: [m.from] });
    store.close();
    store = new SpamStore(file);
    assert.equal(store.signalContext(-12, 10, 1, now).observed, 1);
    assert.equal(store.signalContext(-12, 10, 1, now).joinedAt, now);
    store.prune(1, now + 86_400_001);
    assert.equal(store.signalContext(-12, 10, 1, now + 86_400_001).observed, 0);
    assert.equal(store.signalContext(-12, 10, 1, now + 86_400_001).joinedAt, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter persists explainable contextual proposals, never labels or deletes automatically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spam-context-')),
    file = join(dir, 'db.sqlite');
  const cards: string[] = [];
  const api = {
    getChatMember: async () => ({ status: 'member' }),
    sendMessage: async (_: number, text: string) => {
      cards.push(text);
      return { message_id: 100 };
    },
    deleteMessage: async () => {
      assert.fail('Automatic deletion');
    },
  } as unknown as Api;
  const bot = new SpamTelegram(api, { databasePath: file, chatIds: [-12], retentionDays: 180 });
  try {
    // Cold start still collects behavior, but has no fake classifier score or proposals.
    await bot.message(message(2, 11, -12, normal), 'bot', 1);
    assert.equal(bot.store.signalContext(-12, 11, 2, Date.now()).observed, 1);
    assert.equal(cards.length, 0);
    const ref = bot.store.capture(message(3, 12));
    assert.ok(ref);
    const review = bot.store.createCase(ref);
    bot.store.resolve(review.id, 1, 'spam');
    bot.store.activateModel(-12, artifact, 'test');
    await bot.message(message(), 'bot', 2);
    await bot.message(message(), 'bot', 2);
    assert.equal(cards.length, 1);
    assert.match(cards[0] ?? '', /Similarity spam\/normal/);
    assert.equal(bot.store.dataset(-12).length, 1);
    const db = new DatabaseSync(file);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prediction_signals').get()?.n, 1);
      assert.equal(
        db.prepare('SELECT reason FROM predictions').get()?.reason,
        'context_above_review_threshold',
      );
    } finally {
      db.close();
    }
  } finally {
    bot.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
