import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { CommandQueue } from '../src/bot/commandQueue.ts';
import type { BotDeps } from '../src/bot/deps.ts';
import { handleMessage } from '../src/bot/dispatch.ts';
import { AdminChecker } from '../src/services/admin.ts';
import { MemoryStore } from '../src/store/memoryStore.ts';

function message(id: number, text: string, userId = 1): Message & { reply_to_message: undefined } {
  return {
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -100, type: 'supergroup', title: 'test' },
    from: { id: userId, is_bot: false, first_name: 'User', username: `user${userId}` },
    text,
    reply_to_message: undefined,
  };
}

test('jobs stay FIFO per chat, isolate failures and run other chats independently', async (t) => {
  t.mock.method(console, 'error', () => {});
  const queue = new CommandQueue();
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  queue.enqueue(1, async () => {
    calls.push('first');
    await gate.promise;
    throw new Error('failed command');
  });
  queue.enqueue(1, async () => {
    calls.push('second');
  });
  queue.enqueue(1, async () => {
    calls.push('third');
  });
  queue.enqueue(2, async () => {
    calls.push('other chat');
  });
  await setImmediate();
  assert.deepEqual(calls, ['first', 'other chat']);
  gate.resolve();
  await queue.idle();
  assert.deepEqual(calls, ['first', 'other chat', 'second', 'third']);
  queue.close();
});

test('shutdown discards waiting jobs and waits for the active job', async () => {
  const queue = new CommandQueue();
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  queue.enqueue(1, async () => {
    calls++;
    await gate.promise;
  });
  queue.enqueue(1, async () => {
    calls++;
  });
  queue.close();
  queue.enqueue(2, async () => {
    calls++;
  });
  gate.resolve();
  await queue.idle();
  assert.equal(calls, 1);
});

function fixture() {
  const commands = new CommandQueue();
  const store = new MemoryStore();
  const sent: string[] = [];
  const hits: number[] = [];
  const moderation: string[] = [];
  const api = {
    async sendMessage(_chatId: number, text: string) {
      sent.push(text);
      return message(1000 + sent.length, text);
    },
    async sendAnimation(
      _chatId: number,
      _file: string,
      options: { reply_parameters: { message_id: number } },
    ) {
      hits.push(options.reply_parameters.message_id);
      return message(2000, 'animation');
    },
    async editMessageText() {
      return true;
    },
    async getChatAdministrators() {
      return [{ user: { id: 1 } }];
    },
    async getChatMember(_chatId: number, id: number) {
      return id === 900
        ? { status: 'administrator', can_restrict_members: true, can_delete_messages: true }
        : { status: 'member' };
    },
    async banChatMember() {
      moderation.push('ban');
      return true;
    },
    async restrictChatMember() {
      moderation.push('mute');
      return true;
    },
    async deleteMessages() {
      return true;
    },
  } as unknown as Api;
  const deps = {
    api,
    store,
    commands,
    config: { lefAssetsPath: 'unused' },
    admins: new AdminChecker(api),
    gemini: {
      async selectTagsForContext() {
        return [];
      },
    },
    getBotInfo: async () => ({ id: 900 }),
  } as unknown as BotDeps;
  return { deps, commands, store, sent, hits, moderation };
}

test('three hits are retained; ban/mute overtake them and hit targets stay frozen', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const f = fixture();
  const gate = Promise.withResolvers<string[]>();
  t.mock.method(f.deps.gemini, 'selectTagsForContext', () => gate.promise);
  await f.store.addAnimation('gif');
  await handleMessage(f.deps, message(10, 'old target message', 7));
  for (let id = 11; id <= 13; id++)
    await handleMessage(f.deps, message(id, 'Арматурина фас @user7'));
  await handleMessage(f.deps, message(14, 'new target message', 7));
  for (const text of ['Арматурина уеби', 'Арматурина завари ебало на 10 минут']) {
    await handleMessage(f.deps, {
      ...message(15, text),
      reply_to_message: message(10, 'target', 7),
    });
  }
  assert.deepEqual(f.moderation, ['ban', 'mute']);
  assert.deepEqual(f.hits, []);
  gate.resolve([]);
  await f.commands.idle();
  assert.deepEqual(f.hits, [10, 10, 10]);
  assert.equal(f.store.getChatStats(-100).totalHits, 3);
  f.commands.close();
});

test('three lef animations finish in sequence while moderation runs during the first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);
  const f = fixture();
  let edits = 0;
  t.mock.method(f.deps.api, 'editMessageText', async () => {
    edits++;
    return true;
  });
  for (let id = 1; id <= 3; id++)
    await handleMessage(f.deps, message(id, 'Арматурина сделай горловой'));
  await handleMessage(f.deps, {
    ...message(4, '/ban'),
    reply_to_message: message(10, 'target', 7),
  });
  assert.deepEqual(f.moderation, ['ban']);
  assert.equal(f.sent.filter((text) => text.includes('Прогресс: 1/10')).length, 1);
  for (let i = 0; i < 27; i++) {
    t.mock.timers.tick(1000);
    await setImmediate();
  }
  await f.commands.idle();
  assert.equal(edits, 27);
  assert.equal(f.sent.filter((text) => text.includes('Прогресс: 1/10')).length, 3);
  assert.equal(f.store.getLefTop(-100)[0]?.total, 3);
  f.commands.close();
});

test('queuing a hit does not grant moderation or hit permissions to non-admins', async () => {
  const f = fixture();
  await f.store.addAnimation('gif');
  await handleMessage(f.deps, {
    ...message(1, 'Арматурина фас', 2),
    reply_to_message: message(10, 'target', 7),
  });
  await handleMessage(f.deps, {
    ...message(2, '/ban', 2),
    reply_to_message: message(10, 'target', 7),
  });
  await f.commands.idle();
  assert.deepEqual(f.hits, []);
  assert.deepEqual(f.moderation, []);
  f.commands.close();
});
