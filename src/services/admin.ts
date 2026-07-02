import type { Api } from 'grammy';
import type { Chat, Message } from 'grammy/types';
import { ADMIN_CACHE_TTL_MS } from '../constants.ts';

export function isGroupChat(chat: Chat | undefined): boolean {
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

interface CacheEntry {
  adminIds: Set<number>;
  expiresAt: number;
}

/** Resolves whether a message sender is a chat admin, with a short-lived cache. */
export class AdminChecker {
  private readonly cache = new Map<number, CacheEntry>();
  private readonly api: Api;

  constructor(api: Api) {
    this.api = api;
  }

  async isChatAdmin(message: Message): Promise<boolean> {
    const chatId = message.chat.id;

    // Anonymous group admins post as the chat itself.
    if (message.sender_chat && message.sender_chat.id === chatId) {
      return true;
    }

    const userId = message.from?.id;
    if (!userId) {
      return false;
    }

    return (await this.getAdminIds(chatId)).has(userId);
  }

  private async getAdminIds(chatId: number): Promise<Set<number>> {
    const cached = this.cache.get(chatId);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.adminIds;
    }

    const administrators = await this.api.getChatAdministrators(chatId);
    const adminIds = new Set(administrators.map((member) => member.user.id));

    this.cache.set(chatId, { adminIds, expiresAt: now + ADMIN_CACHE_TTL_MS });

    return adminIds;
  }
}
