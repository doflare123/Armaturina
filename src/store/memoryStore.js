class MemoryStore {
  constructor() {
    // Media pool is global for the running bot process.
    this.stickers = new Map();
    this.animations = new Map();
    this.stickerSets = new Set();

    // Last messages are chat-scoped because replies must happen in the same group.
    this.lastMessagesByChat = new Map();
  }

  rememberMessage(message) {
    if (!message.from || !message.from.username || !message.chat) {
      return;
    }

    const chatId = message.chat.id;
    const username = normalizeUsername(message.from.username);

    if (!this.lastMessagesByChat.has(chatId)) {
      this.lastMessagesByChat.set(chatId, new Map());
    }

    this.lastMessagesByChat.get(chatId).set(username, {
      messageId: message.message_id,
      userId: message.from.id,
      username
    });
  }

  getLastMessage(chatId, username) {
    const chatMessages = this.lastMessagesByChat.get(chatId);

    if (!chatMessages) {
      return null;
    }

    return chatMessages.get(normalizeUsername(username)) || null;
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

module.exports = {
  MemoryStore,
  normalizeUsername
};
