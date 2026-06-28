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
    this.lefStatsByChat = new Map();
    this.moderationAbuseByChat = new Map();

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
      username: message.from.username ? normalizeUsername(message.from.username) : null,
      text: message.text || message.caption || ''
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

  addStickerSet(setName, stickers, pool = 'regular', metadataByFileId = new Map()) {
    const targetStickerSets = pool === 'ultra' ? this.ultraStickerSets : this.stickerSets;
    const targetStickers = pool === 'ultra' ? this.ultraStickers : this.stickers;

    targetStickerSets.add(setName);

    for (const sticker of stickers) {
      if (sticker && sticker.file_id) {
        targetStickers.set(sticker.file_id, {
          type: 'sticker',
          fileId: sticker.file_id,
          setName,
          pool,
          ...normalizeMediaMetadata(metadataByFileId.get(sticker.file_id))
        });
      }
    }

    return stickers.length;
  }

  addAnimation(fileId, pool = 'regular', metadata = {}) {
    const targetAnimations = pool === 'ultra' ? this.ultraAnimations : this.animations;

    targetAnimations.set(fileId, {
      type: 'animation',
      fileId,
      pool,
      ...normalizeMediaMetadata(metadata)
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

  getBestMediaByTags(pool = 'regular', wantedTags = []) {
    const media = this.getMediaList(pool);
    const wanted = normalizeTags(wantedTags);

    if (media.length === 0 || wanted.length === 0) {
      return null;
    }

    const scored = media
      .map((item) => ({
        item,
        score: countTagMatches(item.tags, wanted)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    if (scored.length === 0) {
      return null;
    }

    const bestScore = scored[0].score;
    const best = scored.filter((entry) => entry.score === bestScore);

    return best[Math.floor(Math.random() * best.length)].item;
  }

  getMediaList(pool = 'regular') {
    const stickers = pool === 'ultra' ? this.ultraStickers : this.stickers;
    const animations = pool === 'ultra' ? this.ultraAnimations : this.animations;

    return [
      ...stickers.values(),
      ...animations.values()
    ];
  }

  getUntaggedMedia(pool = 'regular', limit = 25) {
    return this.getMediaList(pool)
      .filter((item) => !item.tags || item.tags.length === 0)
      .slice(0, limit);
  }

  updateMediaMetadata(fileId, pool = 'regular', metadata = {}) {
    const media = this.findMedia(fileId, pool);

    if (!media) {
      return false;
    }

    Object.assign(media, normalizeMediaMetadata(metadata));
    return true;
  }

  findMedia(fileId, pool = 'regular') {
    const stickers = pool === 'ultra' ? this.ultraStickers : this.stickers;
    const animations = pool === 'ultra' ? this.ultraAnimations : this.animations;

    return stickers.get(fileId) || animations.get(fileId) || null;
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

  recordLef(chatId, target) {
    const chatStats = this.getOrCreateLefStats(chatId);
    const targetKey = getTargetKey(target);
    const snake = chatStats.targets.get(targetKey) || {
      userId: target.userId || null,
      username: target.username || null,
      label: target.label || target.username || String(target.userId || targetKey),
      total: 0
    };

    snake.userId = target.userId || snake.userId;
    snake.username = target.username || snake.username;
    snake.label = target.label || snake.label;
    snake.total += 1;
    chatStats.total += 1;
    chatStats.targets.set(targetKey, snake);
  }

  getLefTop(chatId, limit = 10) {
    const chatStats = this.getOrCreateLefStats(chatId);

    return [...chatStats.targets.values()]
      .sort((left, right) => right.total - left.total)
      .slice(0, limit);
  }

  recordModerationAbuse(chatId, user, now = Date.now()) {
    const chatAbuse = this.getOrCreateModerationAbuse(chatId);
    const userKey = getUserKey(user);
    const current = chatAbuse.get(userKey);
    const expired = !current || now - current.lastAt > 30 * 60 * 1000;
    const entry = expired
      ? {
          userId: user.id || null,
          username: user.username || null,
          label: getUserLabel(user),
          count: 0,
          lastAt: 0
        }
      : current;

    entry.userId = user.id || entry.userId;
    entry.username = user.username || entry.username;
    entry.label = getUserLabel(user) || entry.label;
    entry.count += 1;
    entry.lastAt = now;
    chatAbuse.set(userKey, entry);

    return { ...entry };
  }

  getStats() {
    return {
      stickerSets: this.stickerSets.size,
      stickers: this.stickers.size,
      animations: this.animations.size,
      ultraStickerSets: this.ultraStickerSets.size,
      ultraStickers: this.ultraStickers.size,
      ultraAnimations: this.ultraAnimations.size,
      taggedRegular: this.getMediaList('regular').filter((item) => item.tags && item.tags.length > 0).length,
      taggedUltra: this.getMediaList('ultra').filter((item) => item.tags && item.tags.length > 0).length
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
      stats: exportStats(this.statsByChat),
      lefStats: exportLefStats(this.lefStatsByChat),
      moderationAbuse: exportModerationAbuse(this.moderationAbuseByChat)
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
    this.lefStatsByChat = importLefStats(mediaPool.lefStats || {});
    this.moderationAbuseByChat = importModerationAbuse(mediaPool.moderationAbuse || {});

    for (const sticker of mediaPool.stickers || []) {
      if (sticker && sticker.fileId) {
        this.stickers.set(sticker.fileId, {
          type: 'sticker',
          fileId: sticker.fileId,
          setName: sticker.setName || null,
          ...normalizeMediaMetadata(sticker)
        });
      }
    }

    for (const animation of mediaPool.animations || []) {
      if (animation && animation.fileId) {
        this.animations.set(animation.fileId, {
          type: 'animation',
          fileId: animation.fileId,
          ...normalizeMediaMetadata(animation)
        });
      }
    }

    for (const sticker of mediaPool.ultraStickers || []) {
      if (sticker && sticker.fileId) {
        this.ultraStickers.set(sticker.fileId, {
          type: 'sticker',
          fileId: sticker.fileId,
          setName: sticker.setName || null,
          pool: 'ultra',
          ...normalizeMediaMetadata(sticker)
        });
      }
    }

    for (const animation of mediaPool.ultraAnimations || []) {
      if (animation && animation.fileId) {
        this.ultraAnimations.set(animation.fileId, {
          type: 'animation',
          fileId: animation.fileId,
          pool: 'ultra',
          ...normalizeMediaMetadata(animation)
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

  getOrCreateLefStats(chatId) {
    const key = String(chatId);

    if (!this.lefStatsByChat.has(key)) {
      this.lefStatsByChat.set(key, {
        total: 0,
        targets: new Map()
      });
    }

    return this.lefStatsByChat.get(key);
  }

  getOrCreateModerationAbuse(chatId) {
    const key = String(chatId);

    if (!this.moderationAbuseByChat.has(key)) {
      this.moderationAbuseByChat.set(key, new Map());
    }

    return this.moderationAbuseByChat.get(key);
  }
}

function normalizeUsername(username) {
  return String(username).replace(/^@/, '').toLowerCase();
}

function getUserKey(user) {
  if (user.id) {
    return `id:${user.id}`;
  }

  if (user.username) {
    return `username:${normalizeUsername(user.username)}`;
  }

  return `label:${getUserLabel(user)}`;
}

function getUserLabel(user) {
  if (user.username) {
    return `@${user.username}`;
  }

  return user.first_name || user.last_name || String(user.id || 'user');
}

function normalizeMediaMetadata(metadata = {}) {
  return {
    tags: normalizeTags(metadata.tags),
    mood: metadata.mood || null,
    caption: metadata.caption || null,
    analysisFileId: metadata.analysisFileId || null,
    analysisMimeType: metadata.analysisMimeType || null,
    taggedAt: metadata.taggedAt || null
  };
}

function normalizeTags(tags = []) {
  return [...new Set(
    (Array.isArray(tags) ? tags : [])
      .map((tag) => String(tag).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12)
  )];
}

function countTagMatches(actualTags = [], wantedTags = []) {
  const actual = new Set(normalizeTags(actualTags));

  return normalizeTags(wantedTags).filter((tag) => actual.has(tag)).length;
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

function exportLefStats(lefStatsByChat) {
  const result = {};

  for (const [chatId, chatStats] of lefStatsByChat.entries()) {
    result[chatId] = {
      total: chatStats.total,
      targets: Object.fromEntries(chatStats.targets.entries())
    };
  }

  return result;
}

function importLefStats(stats) {
  const statsByChat = new Map();

  for (const [chatId, chatStats] of Object.entries(stats)) {
    const targets = new Map();

    for (const [targetKey, target] of Object.entries(chatStats.targets || {})) {
      targets.set(targetKey, {
        userId: target.userId || null,
        username: target.username || null,
        label: target.label || target.username || targetKey,
        total: target.total || 0
      });
    }

    statsByChat.set(chatId, {
      total: chatStats.total || 0,
      targets
    });
  }

  return statsByChat;
}

function exportModerationAbuse(moderationAbuseByChat) {
  const result = {};

  for (const [chatId, chatAbuse] of moderationAbuseByChat.entries()) {
    result[chatId] = Object.fromEntries(chatAbuse.entries());
  }

  return result;
}

function importModerationAbuse(stats) {
  const moderationAbuseByChat = new Map();

  for (const [chatId, chatStats] of Object.entries(stats)) {
    const chatAbuse = new Map();

    for (const [userKey, entry] of Object.entries(chatStats || {})) {
      chatAbuse.set(userKey, {
        userId: entry.userId || null,
        username: entry.username || null,
        label: entry.label || entry.username || userKey,
        count: entry.count || 0,
        lastAt: entry.lastAt || 0
      });
    }

    moderationAbuseByChat.set(chatId, chatAbuse);
  }

  return moderationAbuseByChat;
}

export {
  MemoryStore,
  normalizeUsername
};
