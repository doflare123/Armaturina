class MemoryStore {
  constructor() {
    // Media pool is global for the running bot process.
    this.stickers = new Map();
    this.animations = new Map();
    this.stickerSets = new Set();

    // Last messages are chat-scoped because replies must happen in the same group.
    this.lastMessagesByUsernameByChat = new Map();
    this.lastMessagesByUserIdByChat = new Map();
  }

  rememberMessage(message) {
    if (!message.from || !message.chat) {
      return;
    }

    const chatId = message.chat.id;
    const lastMessage = {
      messageId: message.message_id,
      userId: message.from.id,
      username: message.from.username ? normalizeUsername(message.from.username) : null
    };

    if (!this.lastMessagesByUserIdByChat.has(chatId)) {
      this.lastMessagesByUserIdByChat.set(chatId, new Map());
    }

    this.lastMessagesByUserIdByChat.get(chatId).set(message.from.id, lastMessage);

    if (!message.from.username) {
      return;
    }

    if (!this.lastMessagesByUsernameByChat.has(chatId)) {
      this.lastMessagesByUsernameByChat.set(chatId, new Map());
    }

    this.lastMessagesByUsernameByChat
      .get(chatId)
      .set(normalizeUsername(message.from.username), lastMessage);
  }

  getLastMessage(chatId, target) {
    if (!target) {
      return null;
    }

    if (target.userId) {
      const userIdMessages = this.lastMessagesByUserIdByChat.get(chatId);
      const message = userIdMessages && userIdMessages.get(target.userId);

      if (message) {
        return message;
      }
    }

    if (!target.username) {
      return null;
    }

    const chatMessages = this.lastMessagesByUsernameByChat.get(chatId);

    if (!chatMessages) {
      return null;
    }

    return chatMessages.get(normalizeUsername(target.username)) || null;
  }

  addStickerSet(setName, stickers) {
    this.stickerSets.add(setName);

    for (const sticker of stickers) {
      if (sticker && sticker.file_id) {
        this.stickers.set(sticker.file_id, {
          type: 'sticker',
          fileId: sticker.file_id,
          setName
        });
      }
    }

    return stickers.length;
  }

  addAnimation(fileId) {
    this.animations.set(fileId, {
      type: 'animation',
      fileId
    });
  }

  getRandomMedia() {
    const media = [
      ...this.stickers.values(),
      ...this.animations.values()
    ];

    if (media.length === 0) {
      return null;
    }

    return media[Math.floor(Math.random() * media.length)];
  }

  getStats() {
    return {
      stickerSets: this.stickerSets.size,
      stickers: this.stickers.size,
      animations: this.animations.size
    };
  }

  exportMediaPool() {
    return {
      stickerSets: [...this.stickerSets.values()],
      stickers: [...this.stickers.values()],
      animations: [...this.animations.values()]
    };
  }

  importMediaPool(mediaPool) {
    this.stickerSets = new Set(mediaPool.stickerSets || []);
    this.stickers = new Map();
    this.animations = new Map();

    for (const sticker of mediaPool.stickers || []) {
      if (sticker && sticker.fileId) {
        this.stickers.set(sticker.fileId, {
          type: 'sticker',
          fileId: sticker.fileId,
          setName: sticker.setName || null
        });
      }
    }

    for (const animation of mediaPool.animations || []) {
      if (animation && animation.fileId) {
        this.animations.set(animation.fileId, {
          type: 'animation',
          fileId: animation.fileId
        });
      }
    }
  }
}

function normalizeUsername(username) {
  return String(username).replace(/^@/, '').toLowerCase();
}

export {
  MemoryStore,
  normalizeUsername
};
