import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import type { BotDeps } from '../src/bot/deps.ts';
import { handleMessage } from '../src/bot/dispatch.ts';
import { handleBan } from '../src/bot/handlers/moderation.ts';
import { AdminChecker } from '../src/services/admin.ts';
import { MemoryStore } from '../src/store/memoryStore.ts';

const CHAT_ID = -100123;
const BOT_ID = 900;
const USER_ID = 7;

interface ApiCalls {
  bans: Array<{ chatId: number | string; userId: number; revokeMessages: boolean | undefined }>;
  deletions: Array<{ chatId: number | string; messageIds: number[] }>;
  sent: string[];
}

function userMessage(messageId: number): Message {
  return {
    message_id: messageId,
    date: Math.floor(Date.now() / 1_000),
    chat: { id: CHAT_ID, type: 'supergroup', title: 'Test' },
    from: { id: USER_ID, is_bot: false, first_name: 'User', username: 'target' },
    text: `message ${messageId}`,
  } as unknown as Message;
}

function banCommand(reply: Message): Message {
  return {
    message_id: 100,
    date: Math.floor(Date.now() / 1_000),
    chat: { id: CHAT_ID, type: 'supergroup', title: 'Test' },
    from: { id: 1, is_bot: false, first_name: 'Admin' },
    text: '/ban',
    reply_to_message: reply,
  } as unknown as Message;
}

function createDeps(canDeleteMessages = true): {
  deps: BotDeps;
  store: MemoryStore;
  calls: ApiCalls;
} {
  const store = new MemoryStore();
  const calls: ApiCalls = { bans: [], deletions: [], sent: [] };
  const api = {
    async getChatAdministrators() {
      return [{ status: 'creator', user: { id: 1, is_bot: false, first_name: 'Admin' } }];
    },
    async getChatMember(_chatId: number | string, userId: number) {
      if (userId === BOT_ID) {
        return {
          status: 'administrator',
          can_restrict_members: true,
          can_delete_messages: canDeleteMessages,
        };
      }
      return { status: 'member' };
    },
    async banChatMember(
      chatId: number | string,
      userId: number,
      options: { revoke_messages?: boolean },
    ) {
      calls.bans.push({ chatId, userId, revokeMessages: options.revoke_messages });
      return true;
    },
    async deleteMessages(chatId: number | string, messageIds: number[]) {
      calls.deletions.push({ chatId, messageIds });
      return true;
    },
    async sendMessage(_chatId: number | string, text: string) {
      calls.sent.push(text);
      return userMessage(999);
    },
  } as unknown as Api;

  const deps = {
    api,
    store,
    admins: new AdminChecker(api),
    getBotInfo: async () => ({ id: BOT_ID }),
  } as unknown as BotDeps;

  return { deps, store, calls };
}

describe('ban cleanup', () => {
  test('a reply ban phrase deletes a fresh message even with an empty store', async () => {
    const { deps, calls } = createDeps();
    const command = { ...banCommand(userMessage(12)), text: 'арматурина уеби' };

    await handleMessage(deps, command);

    assert.deepEqual(calls.bans, [{ chatId: CHAT_ID, userId: USER_ID, revokeMessages: true }]);
    assert.deepEqual(calls.deletions, [{ chatId: CHAT_ID, messageIds: [12] }]);
    assert.deepEqual(calls.sent, ['Уебала @target из чата.']);
  });

  test('a reply ban phrase reports cleanup failure after a successful ban', async () => {
    const { deps, calls } = createDeps();
    deps.api.deleteMessages = async () => {
      throw new Error("Bad Request: message can't be deleted");
    };

    await handleMessage(deps, { ...banCommand(userMessage(12)), text: 'арматурина уеби' });

    assert.equal(calls.bans.length, 1);
    assert.equal(calls.sent.length, 1);
    assert.match(calls.sent[0] ?? '', /Забанила @target, но не смогла дочистить/);
    assert.match(calls.sent[0] ?? '', /message can't be deleted/);
  });

  test('bans with revoke and explicitly deletes remembered and replied-to messages', async () => {
    const { deps, store, calls } = createDeps();
    store.rememberMessage(userMessage(10));
    store.rememberMessage(userMessage(11));
    const reply = userMessage(12);

    await handleBan(deps, banCommand(reply), {
      type: 'ban',
      target: { userId: USER_ID, username: 'target', messageId: 12, label: '@target' },
    });

    assert.deepEqual(calls.bans, [{ chatId: CHAT_ID, userId: USER_ID, revokeMessages: true }]);
    assert.deepEqual(calls.deletions, [{ chatId: CHAT_ID, messageIds: [10, 11, 12] }]);
  });

  test('does not perform a partial ban without message deletion rights', async () => {
    const { deps, calls } = createDeps(false);

    await handleBan(deps, banCommand(userMessage(12)), {
      type: 'ban',
      target: { userId: USER_ID, username: 'target', messageId: 12, label: '@target' },
    });

    assert.deepEqual(calls.bans, []);
    assert.deepEqual(calls.deletions, []);
    assert.match(calls.sent[0] ?? '', /удалять сообщения/);
  });
});
