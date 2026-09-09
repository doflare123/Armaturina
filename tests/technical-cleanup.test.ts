import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { SpamTelegram } from '../src/antispam/telegram.ts';
import {
  isTechnicalCommand,
  TechnicalCleanup,
  withTechnicalCleanup,
} from '../src/bot/technicalCleanup.ts';

const command: Message = {
  message_id: 20,
  date: Math.floor(Date.now() / 1000),
  chat: { id: -12, type: 'supergroup', title: 'test' },
  from: { id: 1, is_bot: false, first_name: 'admin' },
  text: '/spam rewiev',
  reply_to_message: {
    message_id: 10,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -12, type: 'supergroup', title: 'test' },
    from: { id: 2, is_bot: false, first_name: 'user' },
    text: 'Обычное сообщение',
    reply_to_message: undefined,
  },
};

function fixture() {
  const deleted: Array<[number, number]> = [],
    sent: string[] = [];
  const api = {
    async sendMessage(_chat: number, text: string) {
      sent.push(text);
      return { message_id: 100 + sent.length };
    },
    async getChatMember(_chat: number, id: number) {
      return { status: id === 1 ? 'administrator' : 'member', user: { id, is_bot: false } };
    },
    async answerCallbackQuery() {},
    async editMessageText() {},
    async deleteMessage(chat: number, id: number) {
      deleted.push([chat, id]);
      return true;
    },
  } as unknown as Api;
  return { api, deleted, sent };
}

test('cleanup waits 15 seconds, deduplicates, isolates chats and tolerates deletion failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: Array<[number, number]> = [];
  const cleanup = new TechnicalCleanup({
    async deleteMessage(chat, id) {
      calls.push([Number(chat), id]);
      throw new Error('Forbidden');
    },
  });
  try {
    cleanup.schedule(-12, 10, 10, null, undefined, -1);
    cleanup.schedule(-99, 10);
    t.mock.timers.tick(14999);
    await setImmediate();
    assert.deepEqual(calls, []);
    cleanup.schedule(-12, 10); // repeated requests must not postpone the deadline
    t.mock.timers.tick(1);
    await setImmediate();
    assert.deepEqual(calls, [
      [-12, 10],
      [-99, 10],
    ]);
    cleanup.schedule(-12, 30);
    cleanup.close();
    t.mock.timers.tick(15000);
    await setImmediate();
    assert.equal(calls.length, 2);
  } finally {
    cleanup.close();
  }
});

test('technical command wrapper tracks its own text responses, including errors, but never reply targets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(),
    cleanup = new TechnicalCleanup(f.api);
  try {
    await assert.rejects(
      withTechnicalCleanup(f.api, cleanup, command, async (api) => {
        await api.sendMessage(-12, 'progress');
        await api.sendMessage(-99, 'unrelated');
        await api.sendMessage(-12, 'failed');
        throw new Error('handler failed');
      }),
    );
    assert.deepEqual(f.deleted, []);
    t.mock.timers.tick(15000);
    await setImmediate();
    assert.deepEqual(f.deleted, [
      [-12, 20],
      [-12, 101],
      [-12, 103],
    ]);
    assert.equal(isTechnicalCommand({ ...command, text: '/stats@our_bot' }, 'our_bot'), true);
    for (const text of ['/stats@other_bot', '/unknown', '/lef', 'обычный текст'])
      assert.equal(isTechnicalCommand({ ...command, text }, 'our_bot'), false);
  } finally {
    cleanup.close();
  }
});

for (const verdict of ['s', 'n', 'k'])
  test(`review cleanup starts after ${verdict} verdict and preserves pending cards`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(),
      adapter = new SpamTelegram(f.api, {
        chatIds: [-12],
        databasePath: ':memory:',
        retentionDays: 180,
      });
    try {
      await adapter.message(command, 'our_bot');
      const id = /ID: ([a-f0-9-]+)/.exec(f.sent[0] ?? '')?.[1];
      assert.ok(id);
      t.mock.timers.tick(30000);
      await setImmediate();
      assert.deepEqual(f.deleted, []);
      await adapter.callback({
        id: 'q',
        data: `as:${verdict}:${id}`,
        chat_instance: 'chat',
        from: { id: 1, is_bot: false, first_name: 'admin' },
        message: { ...command, message_id: 101 },
      });
      assert.deepEqual(f.deleted, verdict === 's' ? [[-12, 10]] : []);
      t.mock.timers.tick(14999);
      await setImmediate();
      assert.equal(f.deleted.length, verdict === 's' ? 1 : 0);
      t.mock.timers.tick(1);
      await setImmediate();
      assert.deepEqual(f.deleted.slice(verdict === 's' ? 1 : 0), [
        [-12, 101],
        [-12, 20],
      ]);
      assert.equal(adapter.store.dataset(-12).length, verdict === 'k' ? 0 : 1);
    } finally {
      adapter.close();
    }
  });

test('spam stats/error replies clean up; unauthorized callbacks cannot remove a pending review', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(),
    adapter = new SpamTelegram(f.api, {
      chatIds: [-12],
      databasePath: ':memory:',
      retentionDays: 180,
    });
  try {
    await adapter.message({ ...command, text: '/spam stats' }, 'our_bot');
    t.mock.timers.tick(15000);
    await setImmediate();
    assert.deepEqual(f.deleted, [
      [-12, 101],
      [-12, 20],
    ]);
    await adapter.message({ ...command, message_id: 21 }, 'our_bot');
    const id = /ID: ([a-f0-9-]+)/.exec(f.sent[1] ?? '')?.[1];
    assert.ok(id);
    await adapter.callback({
      id: 'q',
      data: `as:n:${id}`,
      chat_instance: 'chat',
      from: { id: 3, is_bot: false, first_name: 'not admin' },
      message: { ...command, message_id: 102 },
    });
    t.mock.timers.tick(15000);
    await setImmediate();
    assert.equal(f.deleted.length, 2);
    assert.equal(adapter.store.getCase(id)?.status, 'PENDING');
  } finally {
    adapter.close();
  }
});
