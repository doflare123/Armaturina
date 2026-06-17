class MemoryStore {
  constructor() {
    // Media pool is global for the running bot process.
    this.stickers = new Map();
    this.animations = new Map();
    this.stickerSets = new Set();
    this.ultraStickers = new Map();
    this.ultraAnimations = new Map();
    this.ultraStickerSets = new Set();
    this.statsByChat = new Map();

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

  addStickerSet(setName, stickers, pool = 'regular') {
    const targetStickerSets = pool === 'ultra' ? this.ultraStickerSets : this.stickerSets;
    const targetStickers = pool === 'ultra' ? this.ultraStickers : this.stickers;

    targetStickerSets.add(setName);

    for (const sticker of stickers) {
      if (sticker && sticker.file_id) {
        targetStickers.set(sticker.file_id, {
          type: 'sticker',
          fileId: sticker.file_id,
          setName,
          pool
        });
      }
    }

    return stickers.length;
  }

  addAnimation(fileId, pool = 'regular') {
    const targetAnimations = pool === 'ultra' ? this.ultraAnimations : this.animations;

    targetAnimations.set(fileId, {
      type: 'animation',
      fileId,
      pool
    });
  }

  getRandomMedia(pool = 'regular') {
    const stickers = pool === 'ultra' ? this.ultraStickers : this.stickers;
    const animations = pool === 'ultra' ? this.ultraAnimations : this.animations;
    const media = [
      ...stickers.values(),
      ...animations.values()
    ];

    if (media.length === 0) {
      return null;
    }

    return media[Math.floor(Math.random() * media.length)];
  }

  hasMedia(pool = 'regular') {
    const stickers = pool === 'ultra' ? this.ultraStickers : this.stickers;
    const animations = pool === 'ultra' ? this.ultraAnimations : this.animations;

    return stickers.size + animations.size > 0;
  }

  recordHit(chatId, target, isUltra = false) {
    const chatStats = this.getOrCreateChatStats(chatId);
    const weekKey = getWeekKey(new Date());
    const targetKey = getTargetKey(target);
    const victim = chatStats.victims.get(targetKey) || {
      userId: target.userId || null,
      username: target.username || null,
      label: target.label || target.username || String(target.userId || targetKey),
      totalHits: 0,
      ultraHits: 0,
      weeklyHits: {}
    };

    victim.userId = target.userId || victim.userId;
    victim.username = target.username || victim.username;
    victim.label = target.label || victim.label;
    victim.totalHits += 1;
    victim.ultraHits += isUltra ? 1 : 0;
    victim.weeklyHits[weekKey] = (victim.weeklyHits[weekKey] || 0) + 1;

    chatStats.totalHits += 1;
    chatStats.ultraHits += isUltra ? 1 : 0;
    chatStats.weeklyHits[weekKey] = (chatStats.weeklyHits[weekKey] || 0) + 1;
    chatStats.victims.set(targetKey, victim);
  }

  getChatStats(chatId) {
    const chatStats = this.getOrCreateChatStats(chatId);
    const weekKey = getWeekKey(new Date());
    const top = this.getWeeklyTop(chatId, 1);

    return {
      totalHits: chatStats.totalHits,
      ultraHits: chatStats.ultraHits,
      uniqueVictims: chatStats.victims.size,
      weekHits: chatStats.weeklyHits[weekKey] || 0,
      weekKey,
      leader: top[0] || null
    };
  }

  getWeeklyTop(chatId, limit = 10) {
    const chatStats = this.getOrCreateChatStats(chatId);
    const weekKey = getWeekKey(new Date());

    return [...chatStats.victims.values()]
      .map((victim) => ({
        userId: victim.userId,
        username: victim.username,
        label: victim.label,
        totalHits: victim.totalHits,
        ultraHits: victim.ultraHits,
        weeklyHits: victim.weeklyHits[weekKey] || 0
      }))
      .filter((victim) => victim.weeklyHits > 0)
      .sort((left, right) => right.weeklyHits - left.weeklyHits || right.totalHits - left.totalHits)
      .slice(0, limit);
  }

  getStats() {
    return {
      stickerSets: this.stickerSets.size,
      stickers: this.stickers.size,
      animations: this.animations.size,
      ultraStickerSets: this.ultraStickerSets.size,
      ultraStickers: this.ultraStickers.size,
      ultraAnimations: this.ultraAnimations.size
    };
  }

  exportMediaPool() {
    return {
      stickerSets: [...this.stickerSets.values()],
      stickers: [...this.stickers.values()],
      animations: [...this.animations.values()],
      ultraStickerSets: [...this.ultraStickerSets.values()],
      ultraStickers: [...this.ultraStickers.values()],
      ultraAnimations: [...this.ultraAnimations.values()],
      stats: exportStats(this.statsByChat)
    };
  }

  importMediaPool(mediaPool) {
    this.stickerSets = new Set(mediaPool.stickerSets || []);
    this.stickers = new Map();
    this.animations = new Map();
    this.ultraStickerSets = new Set(mediaPool.ultraStickerSets || []);
    this.ultraStickers = new Map();
    this.ultraAnimations = new Map();
    this.statsByChat = importStats(mediaPool.stats || {});

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

    for (const sticker of mediaPool.ultraStickers || []) {
      if (sticker && sticker.fileId) {
        this.ultraStickers.set(sticker.fileId, {
          type: 'sticker',
          fileId: sticker.fileId,
          setName: sticker.setName || null,
          pool: 'ultra'
        });
      }
    }

    for (const animation of mediaPool.ultraAnimations || []) {
      if (animation && animation.fileId) {
        this.ultraAnimations.set(animation.fileId, {
          type: 'animation',
          fileId: animation.fileId,
          pool: 'ultra'
        });
      }
    }
  }

  getOrCreateChatStats(chatId) {
    const key = String(chatId);

    if (!this.statsByChat.has(key)) {
      this.statsByChat.set(key, {
        totalHits: 0,
        ultraHits: 0,
        weeklyHits: {},
        victims: new Map()
      });
    }

    return this.statsByChat.get(key);
  }
}

function normalizeUsername(username) {
  return String(username).replace(/^@/, '').toLowerCase();
}

function getTargetKey(target) {
  if (target.userId) {
    return `id:${target.userId}`;
  }

  if (target.username) {
    return `username:${normalizeUsername(target.username)}`;
  }

  return `label:${target.label}`;
}

function getWeekKey(date) {
  const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = current.getUTCDay() || 7;

  current.setUTCDate(current.getUTCDate() + 4 - dayNumber);

  const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((current - yearStart) / 86_400_000) + 1) / 7);

  return `${current.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function exportStats(statsByChat) {
  const result = {};

  for (const [chatId, chatStats] of statsByChat.entries()) {
    result[chatId] = {
      totalHits: chatStats.totalHits,
      ultraHits: chatStats.ultraHits,
      weeklyHits: chatStats.weeklyHits,
      victims: Object.fromEntries(chatStats.victims.entries())
    };
  }

  return result;
}

function importStats(stats) {
  const statsByChat = new Map();

  for (const [chatId, chatStats] of Object.entries(stats)) {
    const victims = new Map();

    for (const [victimKey, victim] of Object.entries(chatStats.victims || {})) {
      victims.set(victimKey, {
        userId: victim.userId || null,
        username: victim.username || null,
        label: victim.label || victim.username || victimKey,
        totalHits: victim.totalHits || 0,
        ultraHits: victim.ultraHits || 0,
        weeklyHits: victim.weeklyHits || {}
      });
    }

    statsByChat.set(chatId, {
      totalHits: chatStats.totalHits || 0,
      ultraHits: chatStats.ultraHits || 0,
      weeklyHits: chatStats.weeklyHits || {},
      victims
    });
  }

  return statsByChat;
}

export {
  MemoryStore,
  normalizeUsername
};
