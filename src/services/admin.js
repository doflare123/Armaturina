const ADMIN_CACHE_TTL_MS = 60_000;

function isGroupChat(chat) {
  return chat && (chat.type === 'group' || chat.type === 'supergroup');
}

class AdminChecker {
  constructor(api) {
    this.api = api;
    this.cache = new Map();
  }

  async isChatAdmin(message) {
    const chatId = message.chat.id;
    const userId = message.from && message.from.id;

    // Anonymous group admins are represented as the chat itself.
    if (message.sender_chat && message.sender_chat.id === chatId) {
      return true;
    }

    if (!userId) {
      return false;
    }

    const adminIds = await this.getAdminIds(chatId);

    return adminIds.has(userId);
  }

  async getAdminIds(chatId) {
    const cached = this.cache.get(chatId);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.adminIds;
    }

    const administrators = await this.api.getChatAdministrators(chatId);
    const adminIds = new Set(administrators.map((member) => member.user.id));

    this.cache.set(chatId, {
      adminIds,
      expiresAt: now + ADMIN_CACHE_TTL_MS
    });

    return adminIds;
  }
}

export {
  isGroupChat,
  AdminChecker
};
