import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Api } from 'grammy';
import type { CallbackQuery, Message } from 'grammy/types';
import { loadSpamConfig } from '../src/antispam/config.ts';
import { normalizeMessage } from '../src/antispam/normalizer.ts';
import { SpamStore } from '../src/antispam/store.ts';
import { SpamTelegram } from '../src/antispam/telegram.ts';

const chatId = -100123;
function message(id = 1, text = 'Привет всем'): Message {
  return {
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'supergroup', title: 'test' },
    from: { id: 10, is_bot: false, first_name: 'user' },
    text,
  };
}

test('normalizer preserves raw, Unicode, mixed scripts and a separate repeated-character view', () => {
  const raw = '  ПрИвЕт\n ＡＢＣ пuши ❤️ Пииииши  ';
  const text = normalizeMessage(raw);
  assert.equal(text.rawText, raw);
  assert.equal(text.normalizedText, 'привет abc пuши ❤️ пииииши');
  assert.equal(text.reducedText, 'привет abc пuши ❤️ пииши');
  assert.equal(normalizeMessage('').normalizedText, '');
  assert.equal(normalizeMessage('  \n').normalizedText, '');
  assert.equal(
    normalizeMessage('HTTPS://x.test/a @Some_user 89991234567 t.me/hello').normalizedText,
    '<URL> <USERNAME> <NUMBER> <URL>',
  );
  assert.equal(normalizeMessage('ПРИВЕТ').textHash, normalizeMessage('привет').textHash);
});

test('configuration is opt-in and rejects invalid group IDs and retention', () => {
  assert.equal(loadSpamConfig({}), undefined);
  assert.deepEqual(loadSpamConfig({ ANTISPAM_CHAT_IDS: '-12,-12,-15' })?.chatIds, [-12, -15]);
  for (const value of ['1', 'NaN', '-1,', '-1.2']) {
    assert.throws(() => loadSpamConfig({ ANTISPAM_CHAT_IDS: value }));
  }
  assert.throws(() =>
    loadSpamConfig({ ANTISPAM_CHAT_IDS: '-12', TRAINING_DATA_RETENTION_DAYS: '0' }),
  );
});

test('capture is idempotent; labels deduplicate, conflicts are excluded and undo removes truth', () => {
  const db = new SpamStore(':memory:');
  try {
    const first = db.capture(message());
    assert.equal(db.capture(message()), first);
    assert.deepEqual(db.dataset(chatId), []);
    assert.ok(first);
    const item = db.createCase(first);
    assert.equal(db.resolve(item.id, 1, 'spam'), true);
    assert.equal(db.resolve(item.id, 2, 'normal'), false);
    assert.equal(db.dataset(chatId)[0]?.label, 1);
    const second = db.capture(message(2));
    assert.ok(second);
    const other = db.createCase(second);
    db.resolve(other.id, 1, 'normal');
    assert.equal(db.dataset(chatId).length, 0);
    assert.equal(db.undo(other.id, 2), true);
    assert.equal(db.undo(other.id, 2), false);
    assert.equal(db.dataset(chatId).length, 1);
    assert.equal(db.dataset(-999).length, 0);
    const corrected = db.createCase(second);
    assert.notEqual(corrected.id, other.id);
    assert.equal(db.resolve(corrected.id, 2, 'spam'), true);
    assert.equal(db.dataset(chatId)[0]?.duplicate_count, 2);
  } finally {
    db.close();
  }
});

test('skip, timeout and observed edits cannot produce training labels', () => {
  const db = new SpamStore(':memory:');
  try {
    for (const mode of ['skip', 'expire', 'edit']) {
      const msg = message(mode === 'skip' ? 1 : mode === 'expire' ? 2 : 3);
      const id = db.capture(msg);
      assert.ok(id);
      const item = db.createCase(id, 1000);
      if (mode === 'skip') assert.equal(db.resolve(item.id, 1, 'skip', 1001), true);
      if (mode === 'expire')
        assert.equal(db.resolve(item.id, 1, 'spam', 1000 + 30 * 60_000), false);
      if (mode === 'edit') {
        db.capture({ ...msg, text: 'changed', edit_date: msg.date + 1 });
        assert.equal(db.resolve(item.id, 1, 'spam', 1001), false);
      }
    }
    assert.equal(db.dataset(chatId).length, 0);
  } finally {
    db.close();
  }
});

test('bootstrap import is validated, transactional, idempotent and chat scoped', () => {
  const db = new SpamStore(':memory:');
  try {
    const samples = [
      { text: 'купи сейчас', label: 'spam' },
      { text: 'Доброе утро', label: 'normal' },
    ];
    assert.equal(db.importBootstrap(chatId, samples), 2);
    assert.equal(db.importBootstrap(chatId, samples), 0);
    assert.throws(() =>
      db.importBootstrap(chatId, [
        { text: 'новый', label: 'normal' },
        { text: 'купи сейчас', label: 'normal' },
      ]),
    );
    assert.equal(db.dataset(chatId).length, 2);
    assert.throws(() => db.importBootstrap(chatId, [{ text: 'x', label: 'AUTO_PREDICTION' }]));
    assert.equal(db.importBootstrap(-999, samples), 2);
    db.prune(1, Date.now() + 2 * 86_400_000);
    assert.equal(db.dataset(chatId).length, 0);
  } finally {
    db.close();
  }
});

test('edited snapshots can be reviewed without relabeling the original or accepting stale replies', () => {
  const db = new SpamStore(':memory:');
  try {
    const original = message();
    const id = db.capture(original, 1);
    assert.ok(id);
    const item = db.createCase(id);
    const edited = { ...original, text: 'changed', edit_date: original.date + 1 };
    const next = db.capture(edited, 2);
    assert.ok(next);
    assert.notEqual(next, id);
    assert.equal(db.getCase(item.id)?.status, 'EXPIRED');
    assert.equal(db.resolve(item.id, 1, 'spam'), false);
    assert.equal(db.capture(original, 1), null);
    assert.equal(db.capture(edited, 2), next);
    assert.equal(db.dataset(chatId).length, 0);
    const review = db.createCase(next);
    assert.equal(review.raw_text, 'changed');
    assert.equal(review.revision, 1);
    assert.equal(db.resolve(review.id, 1, 'normal'), true);
    assert.equal(db.dataset(chatId)[0]?.normalized_text, 'changed');
  } finally {
    db.close();
  }
});

test('same-second edits are ordered by update_id; hidden links and caption removal invalidate old cards', () => {
  const db = new SpamStore(':memory:');
  try {
    const base = message(90, 'Ссылка');
    const first = db.capture(base, 100);
    assert.ok(first);
    const card = db.createCase(first);
    const edit = {
      ...base,
      edit_date: base.date + 1,
      entities: [{ type: 'text_link' as const, offset: 0, length: 6, url: 'https://one.example' }],
    };
    const second = db.capture(edit, 101);
    assert.ok(second);
    const newer = {
      ...edit,
      entities: edit.entities.map((entity) => ({ ...entity, url: 'https://two.example' })),
    };
    const third = db.capture(newer, 102);
    assert.ok(third);
    assert.notEqual(third, second);
    assert.equal(db.capture(edit, 101), null);
    assert.equal(db.capture(newer, 102), third);
    assert.equal(db.resolve(card.id, 1, 'spam'), false);
    const current = db.createCase(third);
    assert.match(current.metadata, /two.example/);
    assert.equal(db.capture({ ...newer, text: '', edit_date: base.date + 2 }, 103), null);
    assert.equal(db.resolve(current.id, 1, 'normal'), false);
    assert.equal(db.capture(newer, 102), null);
    const restored = db.capture({ ...newer, text: 'Новая подпись', edit_date: base.date + 3 }, 104);
    assert.ok(restored);
    assert.notEqual(restored, third);
  } finally {
    db.close();
  }
});

test('human labels stay attached to historical text after edits and undo does not affect the new version', () => {
  const db = new SpamStore(':memory:');
  try {
    const base = message();
    const first = db.capture(base);
    assert.ok(first);
    const normal = db.createCase(first);
    assert.equal(db.resolve(normal.id, 1, 'normal'), true);
    const next = db.capture({ ...base, text: 'Покупайте рекламу', edit_date: base.date + 1 });
    assert.ok(next);
    assert.equal(db.dataset(chatId).length, 1);
    const spam = db.createCase(next);
    assert.equal(db.resolve(spam.id, 1, 'spam'), true);
    assert.equal(db.dataset(chatId).length, 2);
    assert.equal(db.undo(normal.id, 1), true);
    assert.equal(db.dataset(chatId).length, 1);
    assert.equal(db.dataset(chatId)[0]?.label, 1);
    db.prune(1, Date.now() + 2 * 86_400_000);
    assert.equal(db.getCase(spam.id), undefined);
    assert.deepEqual(db.dataset(chatId), []);
  } finally {
    db.close();
  }
});

test('manual review accepts an edited caption first seen by the bot', async () => {
  const f = fixture();
  try {
    const base = message();
    const edited = {
      ...base,
      text: undefined,
      caption: 'Купить товар',
      edit_date: base.date + 1,
    } as Message;
    await f.adapter.edited(edited, 10);
    await f.adapter.message(
      { ...f.command, reply_to_message: { ...edited, reply_to_message: undefined } },
      'test_bot',
      11,
    );
    assert.match(f.sent[0]?.text ?? '', /Купить товар/);
    const id = /ID: ([0-9a-f-]+)/.exec(f.sent[0]?.text ?? '')?.[1];
    assert.ok(id);
    await f.adapter.callback(f.query(id, 'n'));
    assert.equal(f.adapter.store.dataset(chatId)[0]?.label, 0);
    assert.deepEqual(f.deleted, []);
  } finally {
    f.adapter.close();
  }
});

test('an edit arriving during admin verification prevents the old callback from deleting the new text', async () => {
  const f = fixture();
  try {
    await f.adapter.message(f.command, 'test_bot', 1);
    const id = /ID: ([0-9a-f-]+)/.exec(f.sent[0]?.text ?? '')?.[1];
    assert.ok(id);
    const callback = f.adapter.callback(f.query(id));
    const base = f.command.reply_to_message;
    assert.ok(base);
    await f.adapter.edited({ ...base, text: 'Совсем другой текст', edit_date: base.date + 1 }, 2);
    await callback;
    assert.deepEqual(f.deleted, []);
    assert.deepEqual(f.adapter.store.dataset(chatId), []);
    assert.equal(f.adapter.store.getCase(id)?.status, 'EXPIRED');
  } finally {
    f.adapter.close();
  }
});

test('separate connections arbitrate the first verdict; restart persists data; prediction is not truth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antispam-'));
  const file = join(dir, 'test.sqlite');
  const first = new SpamStore(file);
  const second = new SpamStore(file);
  try {
    const id = first.capture(message());
    assert.ok(id);
    const item = first.createCase(id);
    assert.equal(first.resolve(item.id, 1, 'normal'), true);
    assert.equal(second.resolve(item.id, 2, 'spam'), false);
    assert.equal(second.dataset(chatId)[0]?.label, 0);
    const predictionId = first.capture(message(2, 'predicted'));
    const raw = new DatabaseSync(file);
    try {
      raw
        .prepare(
          "INSERT INTO labels(message_id,label,source,created_at) VALUES (?,1,'AUTO_PREDICTION',?)",
        )
        .run(predictionId, Date.now());
    } finally {
      raw.close();
    }
    assert.equal(second.dataset(chatId).length, 1);
  } finally {
    first.close();
    second.close();
  }
  const reopened = new SpamStore(file);
  try {
    assert.equal(reopened.dataset(chatId).length, 1);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true });
  }
});

function fixture() {
  const sent: Array<{ text: string; options: unknown }> = [];
  const deleted: number[] = [];
  const answers: string[] = [];
  const edits: string[] = [];
  let admin = true;
  let failDelete = false;
  let protectedTarget = false;
  const api = {
    async getChatMember(_chat: number, id: number) {
      return {
        status: (id === 1 && admin) || (id === 10 && protectedTarget) ? 'administrator' : 'member',
        user: { id, is_bot: false },
      };
    },
    async sendMessage(_chat: number, text: string, options: unknown) {
      sent.push({ text, options });
      return { message_id: 50 };
    },
    async deleteMessage(_chat: number, id: number) {
      if (failDelete) throw new Error('denied');
      deleted.push(id);
    },
    async answerCallbackQuery(_id: string, options: { text: string }) {
      answers.push(options.text);
    },
    async editMessageText(_chat: number, _id: number, text: string) {
      edits.push(text);
    },
  } as unknown as Api;
  const adapter = new SpamTelegram(api, {
    chatIds: [chatId],
    databasePath: ':memory:',
    retentionDays: 180,
  });
  const command = {
    ...message(2, '/spam review'),
    from: { id: 1, is_bot: false, first_name: 'admin' },
    reply_to_message: message(),
  } as Message;
  function query(id: string, choice = 's', chat = chatId): CallbackQuery {
    return {
      id: 'query',
      from: { id: 1, is_bot: false, first_name: 'admin' },
      chat_instance: 'chat',
      data: `as:${choice}:${id}`,
      message: { ...message(50), chat: { id: chat, type: 'supergroup', title: 'test' } },
    };
  }
  return {
    adapter,
    command,
    query,
    deleted,
    answers,
    edits,
    sent,
    revoke: () => {
      admin = false;
    },
    failDelete: () => {
      failDelete = true;
    },
    protect: () => {
      protectedTarget = true;
    },
  };
}

test('Telegram review → concurrent callbacks → one deletion and label; undo removes label', async () => {
  const f = fixture();
  try {
    await f.adapter.message(message(), 'test_bot');
    assert.equal(f.adapter.store.dataset(chatId).length, 0);
    await f.adapter.message(f.command, 'test_bot');
    const id = /ID: ([0-9a-f-]+)/.exec(f.sent[0]?.text ?? '')?.[1];
    assert.ok(id);
    await Promise.all([f.adapter.callback(f.query(id)), f.adapter.callback(f.query(id))]);
    assert.deepEqual(f.deleted, [1]);
    assert.equal(f.adapter.store.dataset(chatId)[0]?.label, 1);
    await f.adapter.message({ ...f.command, text: `/spam undo ${id}` }, 'test_bot');
    assert.equal(f.adapter.store.dataset(chatId).length, 0);
  } finally {
    f.adapter.close();
  }
});

test('callbacks reject wrong chat, revoked admins and protected authors; normal never deletes', async () => {
  const f = fixture();
  try {
    await f.adapter.message(f.command, 'test_bot');
    const id = /ID: ([0-9a-f-]+)/.exec(f.sent[0]?.text ?? '')?.[1];
    assert.ok(id);
    await f.adapter.callback(f.query(id, 's', -999));
    assert.equal(f.adapter.store.dataset(chatId).length, 0);
    f.protect();
    await f.adapter.callback(f.query(id));
    assert.equal(f.adapter.store.dataset(chatId).length, 0);
    await f.adapter.callback(f.query(id, 'n'));
    assert.equal(f.adapter.store.dataset(chatId)[0]?.label, 0);
    assert.deepEqual(f.deleted, []);
    f.revoke();
    await f.adapter.message({ ...f.command, text: `/spam undo ${id}` }, 'test_bot');
    assert.equal(f.adapter.store.dataset(chatId).length, 1);
  } finally {
    f.adapter.close();
  }
});

test('deletion failure is explicit and never discards confirmed human feedback', async () => {
  const f = fixture();
  try {
    await f.adapter.message(f.command, 'test_bot');
    const id = /ID: ([0-9a-f-]+)/.exec(f.sent[0]?.text ?? '')?.[1];
    assert.ok(id);
    f.failDelete();
    await f.adapter.callback(f.query(id));
    assert.equal(f.adapter.store.dataset(chatId)[0]?.label, 1);
    assert.match(f.edits[0] ?? '', /Удаление не удалось/);
  } finally {
    f.adapter.close();
  }
});

test('unconfigured chats, private messages and commands addressed to another bot are not collected', async () => {
  const f = fixture();
  try {
    await f.adapter.message(
      { ...message(), chat: { id: -999, type: 'supergroup', title: 'other' } },
      'test_bot',
    );
    await f.adapter.message(
      { ...message(), chat: { id: 123, type: 'private', first_name: 'user' } },
      'test_bot',
    );
    await f.adapter.message({ ...f.command, text: '/spam@other_bot review' }, 'test_bot');
    assert.equal(f.sent.length, 0);
    assert.equal(f.adapter.store.stats(chatId)?.messages, 0);
  } finally {
    f.adapter.close();
  }
});
