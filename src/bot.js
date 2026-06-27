import { Bot, InputFile } from 'grammy';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileStore } from './store/fileStore.js';
import { AdminChecker, isGroupChat } from './services/admin.js';
import { GeminiService } from './services/gemini.js';
import { parseAction } from './services/parser.js';
import {
  addGifFromReply,
  addStickerPackFromName,
  addStickerPackFromReply
} from './services/mediaPool.js';

const ULTRA_HIT_CHANCE = 0.01;
const ULTRA_CHARGE_STEPS = [0, 20, 40, 60, 80, 100];
const ULTRA_CHARGE_STEP_DELAY_MS = 650;
const LEF_IMAGE_CHANCE = 0.1;
const LEF_ANIMATION_DELAY_MS = 1_000;
const LEF_ANIMATION_FRAMES = [
  'Подготовка комиссии...',
  'Проверяю давление в системе...',
  'Смазываю бюрократию...',
  'Причмокиваю протокол...',
  'Запускаю слюнявый контур...',
  'Калибрую горловой модуль...',
  'Шлепаю печать качества...',
  'Финальный причмок...',
  'Закрываю наряд-допуск...',
  'Оформлено.'
];
const MUTE_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false
};

function createBot(config) {
  const bot = new Bot(config.token);
  const store = new FileStore(config.dataFilePath);
  const adminChecker = new AdminChecker(bot.api);
  const gemini = new GeminiService({
    ...config.gemini,
    telegramToken: config.token
  });
  let botInfo = null;
  let started = false;
  let pollingPromise = null;

  async function start() {
    if (started) {
      return;
    }

    await store.load();
    botInfo = await bot.api.getMe();

    bot.on('message', async (ctx) => {
      await handleMessage(ctx.message);
    });

    bot.catch((error) => {
      console.error('Telegram bot error:', error.error);
    });

    started = true;
    pollingPromise = bot.start();
    pollingPromise.catch((error) => {
      console.error('Armaturina polling stopped with error:', error);
    });

    console.log('Armaturina bot started.');
  }

  async function stop() {
    if (!started) {
      return;
    }

    await bot.stop();
    started = false;
  }

  async function handleMessage(message) {
    if (!isGroupChat(message.chat)) {
      await handlePrivateMessage(message);
      return;
    }

    const action = parseAction(message);

    if (isPublicAction(action)) {
      await handlePublicAction(message, action);
      store.rememberMessage(message);
      return;
    }

    if (action.type !== 'none') {
      await handleAdminAction(message, action);
    }

    // Remember after handling so admin command messages do not replace target history first.
    store.rememberMessage(message);
  }

  async function handlePrivateMessage(message) {
    await bot.api.sendMessage(
      message.chat.id,
      'Я работаю только в группах. Добавь меня в группу, дай права читать сообщения, и там начнется арматурный движ.'
    );
  }

  async function handleAdminAction(message, action) {
    const admin = await canUseAdminAction(message);

    if (!admin) {
      return;
    }

    if (action.type === 'help') {
      await sendHelp(message.chat.id);
      return;
    }

    if (action.type === 'pool') {
      await sendPoolStats(message.chat.id);
      return;
    }

    if (action.type === 'add_sticker_pack') {
      await handleAddStickerPack(message, action.packName, action.pool);
      return;
    }

    if (action.type === 'add_gif') {
      await handleAddGif(message, action.pool);
      return;
    }

    if (action.type === 'retag') {
      await handleRetag(message, action.pool, action.limit);
      return;
    }

    if (action.type === 'mute') {
      await handleMute(message, action);
      return;
    }

    if (action.type === 'ban') {
      await handleBan(message, action);
      return;
    }

    if (action.type === 'hit') {
      await handleHit(message, action.target);
    }
  }

  function isPublicAction(action) {
    return action.type === 'stats' || action.type === 'top' || action.type === 'lef_top' || action.type === 'lef';
  }

  async function handlePublicAction(message, action) {
    if (action.type === 'stats') {
      await sendStats(message.chat.id);
      return;
    }

    if (action.type === 'top') {
      await sendTop(message.chat.id);
      return;
    }

    if (action.type === 'lef_top') {
      await sendLefTop(message.chat.id);
      return;
    }

    if (action.type === 'lef') {
      await handleLef(message, action);
    }
  }

  async function canUseAdminAction(message) {
    try {
      return await adminChecker.isChatAdmin(message);
    } catch (error) {
      console.error('Failed to check chat administrators:', error);

      await bot.api.sendMessage(
        message.chat.id,
        'Не могу проверить права админа. Дай боту права администратора в группе, иначе Telegram не отдает список админов.'
      );

      return false;
    }
  }

  async function handleAddStickerPack(message, packName, pool = 'regular') {
    try {
      const tagger = gemini.isEnabled() ? gemini : null;
      const result = packName
        ? await addStickerPackFromName(bot.api, store, packName, pool, tagger)
        : await addStickerPackFromReply(bot.api, store, message, pool, tagger);

      if (!result) {
        await bot.api.sendMessage(message.chat.id, 'Ответь на стикер или укажи имя стикерпака.');
        return;
      }

      await bot.api.sendMessage(
        message.chat.id,
        `Стикерпак ${result.setName} добавлен в ${getPoolLabel(pool)} пул. Стикеров: +${result.addedCount}. Протегировано: ${result.taggedCount}.`
      );
    } catch (error) {
      await bot.api.sendMessage(message.chat.id, `Не смогла добавить стикерпак: ${error.message}`);
    }
  }

  async function handleAddGif(message, pool = 'regular') {
    const tagger = gemini.isEnabled() ? gemini : null;
    const result = await addGifFromReply(bot.api, store, message, pool, tagger);

    if (!result) {
      await bot.api.sendMessage(message.chat.id, 'Ответь командой на GIF/animation, которую нужно добавить.');
      return;
    }

    await bot.api.sendMessage(
      message.chat.id,
      `GIF добавлена в ${getPoolLabel(pool)} пул.${result.tagged ? ' Теги на месте.' : ''}`
    );
  }

  async function handleRetag(message, pool, limit) {
    if (!gemini.isEnabled()) {
      await bot.api.sendMessage(message.chat.id, 'Gemini выключен: укажи ARMATURINA_GEMINI_API_KEY.');
      return;
    }

    const pools = pool === 'all' ? ['regular', 'ultra'] : [pool];
    let tagged = 0;
    let seen = 0;

    for (const currentPool of pools) {
      const mediaItems = store.getUntaggedMedia(currentPool, limit - seen);

      for (const media of mediaItems) {
        seen += 1;

        const metadata = await gemini.tagTelegramMedia(bot.api, {
          kind: media.type,
          fileId: media.fileId,
          thumbnailFileId: media.analysisFileId
        });

        await store.updateMediaMetadata(media.fileId, currentPool, metadata);

        if (metadata.tags && metadata.tags.length > 0) {
          tagged += 1;
        }
      }
    }

    await bot.api.sendMessage(
      message.chat.id,
      `Ретег готов. Проверено: ${seen}, протегировано: ${tagged}.`
    );
  }

  function resolveModerationTarget(chatId, target) {
    if (!target) {
      return null;
    }

    if (target.userId) {
      return {
        userId: target.userId,
        username: target.username || null,
        label: target.label || (target.username ? `@${target.username}` : `id:${target.userId}`)
      };
    }

    const targetMessage = store.getLastMessage(chatId, target);

    return resolveModerationTargetFromLastMessage(target, targetMessage);
  }

  async function handleMute(message, action) {
    const target = resolveModerationTarget(message.chat.id, action.target);

    if (!target) {
      await bot.api.sendMessage(
        message.chat.id,
        'Не нашла кого мутить. Ответь командой на сообщение человека или используй @username того, кто уже писал в группе.'
      );
      return;
    }

    if (!await canBotModerate(message.chat.id)) {
      await bot.api.sendMessage(
        message.chat.id,
        'Не могу мутить: сделай бота админом и включи ему право банить/ограничивать участников.'
      );
      return;
    }

    const untilDate = Math.floor(Date.now() / 1000) + action.minutes * 60;

    try {
      await bot.api.restrictChatMember(
        message.chat.id,
        target.userId,
        MUTE_PERMISSIONS,
        { until_date: untilDate }
      );

      await bot.api.sendMessage(
        message.chat.id,
        `Заварила ебало ${target.label} на ${action.minutes} мин.`
      );
    } catch (error) {
      if (isChatAdminRequiredError(error)) {
        await bot.api.sendMessage(
          message.chat.id,
          'Telegram не дал замутить: у бота нет админского права банить/ограничивать участников.'
        );
        return;
      }

      await bot.api.sendMessage(
        message.chat.id,
        `Не смогла замутить ${target.label}: ${error.message}`
      );
    }
  }

  async function handleBan(message, action) {
    const target = resolveModerationTarget(message.chat.id, action.target);

    if (!target) {
      await bot.api.sendMessage(
        message.chat.id,
        'Не нашла кого банить. Ответь командой на сообщение человека или используй @username того, кто уже писал в группе.'
      );
      return;
    }

    if (!await canBotModerate(message.chat.id)) {
      await bot.api.sendMessage(
        message.chat.id,
        'Не могу банить: сделай бота админом и включи ему право банить/ограничивать участников.'
      );
      return;
    }

    try {
      await bot.api.banChatMember(message.chat.id, target.userId, {
        revoke_messages: true
      });

      await bot.api.sendMessage(
        message.chat.id,
        `Уебала ${target.label} из чата.`
      );
    } catch (error) {
      if (isChatAdminRequiredError(error)) {
        await bot.api.sendMessage(
          message.chat.id,
          'Telegram не дал забанить: у бота нет админского права банить/ограничивать участников.'
        );
        return;
      }

      await bot.api.sendMessage(
        message.chat.id,
        `Не смогла забанить ${target.label}: ${error.message}`
      );
    }
  }

  async function handleLef(message, action) {
    const target = resolveLefTarget(message.chat.id, action.target);

    if (!target) {
      await bot.api.sendMessage(message.chat.id, 'Не нашла кому оформлять. Используй @username того, кто уже писал в группе.');
      return;
    }

    if (Math.random() < LEF_IMAGE_CHANCE) {
      const imagePath = await getRandomLefImage(config.lefAssetsPath);

      if (imagePath) {
        await bot.api.sendPhoto(message.chat.id, new InputFile(imagePath), {
          caption: `Оформлено для ${target.label}.`
        });
        await store.recordLef(message.chat.id, target);
        return;
      }
    }

    await playLefAnimation(message.chat.id, target, action.variant);
    await store.recordLef(message.chat.id, target);
  }

  function resolveLefTarget(chatId, target) {
    if (!target) {
      return null;
    }

    if (target.userId) {
      return {
        userId: target.userId,
        username: target.username || null,
        label: target.label || (target.username ? `@${target.username}` : `id:${target.userId}`)
      };
    }

    const targetMessage = store.getLastMessage(chatId, target);

    if (!targetMessage) {
      return {
        userId: null,
        username: target.username || null,
        label: target.label || (target.username ? `@${target.username}` : 'цель')
      };
    }

    return {
      userId: targetMessage.userId,
      username: target.username || targetMessage.username || null,
      label: target.label || (target.username ? `@${target.username}` : `id:${targetMessage.userId}`)
    };
  }

  async function canBotModerate(chatId) {
    if (!botInfo) {
      botInfo = await bot.api.getMe();
    }

    try {
      const member = await bot.api.getChatMember(chatId, botInfo.id);

      if (member.status === 'creator') {
        return true;
      }

      return member.status === 'administrator' && Boolean(member.can_restrict_members);
    } catch (error) {
      console.error('Failed to check bot moderation permissions:', error);
      return false;
    }
  }

  async function handleHit(message, target) {
    const targetMessage = target && target.messageId
      ? {
          messageId: target.messageId,
          userId: target.userId,
          username: target.username,
          text: target.text || ''
        }
      : store.getLastMessage(message.chat.id, target);
    const targetLabel = target && target.label ? target.label : 'цели';

    if (!targetMessage) {
      await bot.api.sendMessage(
        message.chat.id,
        `Не нашла последнее сообщение ${targetLabel}. Сначала этот человек должен что-нибудь написать в группе.`
      );
      return;
    }

    const isUltra = Math.random() < ULTRA_HIT_CHANCE && store.hasMedia('ultra');
    const pool = isUltra ? 'ultra' : 'regular';
    const wantedTags = await gemini.selectTagsForContext(getHitContextText(message, targetMessage));
    const media = store.getBestMediaByTags(pool, wantedTags) || store.getRandomMedia(pool);

    if (!media) {
      await bot.api.sendMessage(message.chat.id, 'Пул пустой. Админ должен добавить стикерпак или GIF.');
      return;
    }

    const options = {
      reply_to_message_id: targetMessage.messageId,
      allow_sending_without_reply: true
    };

    if (isUltra) {
      await playUltraCharge(message.chat.id, options);
    }

    if (media.type === 'sticker') {
      await bot.api.sendSticker(message.chat.id, media.fileId, options);
      await store.recordHit(message.chat.id, buildStatsTarget(target, targetMessage), isUltra);
      return;
    }

    await bot.api.sendAnimation(message.chat.id, media.fileId, options);
    await store.recordHit(message.chat.id, buildStatsTarget(target, targetMessage), isUltra);
  }

  async function sendHelp(chatId) {
    await bot.api.sendMessage(chatId, [
      'Арматурина слушает только админов в группе.',
      '',
      'Ударить: Арматурина, дай по хрептине @username',
      'Добавить стикерпак: /addstickerpack pack_name',
      'Добавить ultra стикерпак: /addultrastickerpack pack_name',
      'Добавить пак из стикера: ответь на стикер фразой "Арматурина, добавь стикерпак"',
      'Добавить GIF: ответь на GIF фразой "Арматурина, добавь гифку" или /addgif',
      'Добавить ultra GIF: ответь на GIF командой /addultragif',
      'Статистика: /stats',
      'Топ недели: /top',
      'Мут: ответь /mute 10 или напиши /mute @username 10',
      'Мут фразой: Арматурина завари ебало на 10 минут',
      'Бан с удалением сообщений: ответь /ban или напиши /ban @username',
      'Бан фразой: Арматурина уеби его',
      'Оформить: Арматурина оформи горловой / слюнявый / минет',
      'Змеиный топ: /lef_top',
      'Пул: /pool'
    ].join('\n'));
  }

  async function sendPoolStats(chatId) {
    const stats = store.getStats();

    await bot.api.sendMessage(
      chatId,
      `Пул: ${stats.stickerSets} стикерпаков, ${stats.stickers} стикеров, ${stats.animations} GIF, тегов: ${stats.taggedRegular}.\nUltra-пул: ${stats.ultraStickerSets} стикерпаков, ${stats.ultraStickers} стикеров, ${stats.ultraAnimations} GIF, тегов: ${stats.taggedUltra}.`
    );
  }

  async function sendStats(chatId) {
    const stats = store.getChatStats(chatId);
    const leaderLine = stats.leader
      ? `Почетная хрептина недели: ${stats.leader.label} (${stats.leader.weeklyHits})`
      : 'Почетная хрептина недели пока не выбрана.';

    await bot.api.sendMessage(chatId, [
      'Арматурная статистика:',
      `Всего ударов: ${stats.totalHits}`,
      `Ультра ударов: ${stats.ultraHits}`,
      `Уникальных хрептин: ${stats.uniqueVictims}`,
      `Ударов за неделю ${stats.weekKey}: ${stats.weekHits}`,
      leaderLine
    ].join('\n'));
  }

  async function sendTop(chatId) {
    const top = store.getWeeklyTop(chatId, 10);

    if (top.length === 0) {
      await bot.api.sendMessage(chatId, 'Почетная хрептина недели пока не выявлена.');
      return;
    }

    const lines = top.map((victim, index) => {
      const ultraText = victim.ultraHits > 0 ? `, ultra: ${victim.ultraHits}` : '';

      return `${index + 1}. ${victim.label} — ${victim.weeklyHits}${ultraText}`;
    });

    await bot.api.sendMessage(chatId, [
      'Топ недели: Почетная хрептина недели',
      ...lines
    ].join('\n'));
  }

  async function sendLefTop(chatId) {
    const top = store.getLefTop(chatId, 10);

    if (top.length === 0) {
      await bot.api.sendMessage(chatId, 'Змеиный топ пока пуст.');
      return;
    }

    const lines = top.map((target, index) => {
      const title = index === 0 ? ' - король змей' : '';

      return `${index + 1}. ${target.label} - ${target.total}${title}`;
    });

    await bot.api.sendMessage(chatId, [
      'Змеиный топ:',
      ...lines
    ].join('\n'));
  }

  async function playLefAnimation(chatId, target, variant) {
    const message = await bot.api.sendMessage(
      chatId,
      buildLefFrameText(target, variant, LEF_ANIMATION_FRAMES[0], 1)
    );

    for (let index = 1; index < LEF_ANIMATION_FRAMES.length; index += 1) {
      await delay(LEF_ANIMATION_DELAY_MS);

      await bot.api.editMessageText(
        chatId,
        message.message_id,
        buildLefFrameText(target, variant, LEF_ANIMATION_FRAMES[index], index + 1)
      );
    }
  }

  async function playUltraCharge(chatId, options) {
    let chargeMessage = null;

    try {
      chargeMessage = await bot.api.sendMessage(
        chatId,
        buildUltraChargeText(0),
        options
      );

      for (const percent of ULTRA_CHARGE_STEPS.slice(1)) {
        await delay(ULTRA_CHARGE_STEP_DELAY_MS);

        await bot.api.editMessageText(
          chatId,
          chargeMessage.message_id,
          buildUltraChargeText(percent)
        );
      }

      await delay(ULTRA_CHARGE_STEP_DELAY_MS);
      await bot.api.deleteMessage(chatId, chargeMessage.message_id);
    } catch (error) {
      console.error('Failed to play ultra charge animation:', error);

      if (chargeMessage) {
        await bot.api.deleteMessage(chatId, chargeMessage.message_id).catch(() => {});
      }
    }
  }

  return {
    start,
    stop,
    bot,
    store,
    get pollingPromise() {
      return pollingPromise;
    }
  };
}

function buildStatsTarget(target, targetMessage) {
  const username = target.username || targetMessage.username || null;
  const userId = target.userId || targetMessage.userId || null;

  return {
    userId,
    username,
    label: target.label || (username ? `@${username}` : `id:${userId}`)
  };
}

function getPoolLabel(pool) {
  return pool === 'ultra' ? 'ultra' : 'обычный';
}

function resolveModerationTargetFromLastMessage(target, targetMessage) {
  if (!targetMessage || !targetMessage.userId) {
    return null;
  }

  const username = target.username || targetMessage.username || null;

  return {
    userId: targetMessage.userId,
    username,
    label: target.label || (username ? `@${username}` : `id:${targetMessage.userId}`)
  };
}

function getHitContextText(message, targetMessage) {
  return targetMessage.text || message.reply_to_message?.text || message.reply_to_message?.caption || message.text || message.caption || '';
}

function buildUltraChargeText(percent) {
  const filledCount = Math.floor(percent / 20);
  const emptyCount = 5 - filledCount;
  const bar = `${'🟩'.repeat(filledCount)}${'⬛'.repeat(emptyCount)}`;

  if (percent === 100) {
    return `${bar} ${percent}%\nЛови маслину`;
  }

  return `${bar} ${percent}%\nЗарядка мега-хрептины`;
}

function buildLefFrameText(target, variant, frame, index) {
  const progress = `${index}/${LEF_ANIMATION_FRAMES.length}`;

  return [
    `${frame}`,
    '',
    `Цель: ${target.label}`,
    `Тип: ${variant}`,
    `Прогресс: ${progress}`
  ].join('\n');
}

async function getRandomLefImage(lefAssetsPath) {
  const imagePaths = await getLefImagePaths(lefAssetsPath);

  if (imagePaths.length === 0) {
    return null;
  }

  return imagePaths[Math.floor(Math.random() * imagePaths.length)];
}

async function getLefImagePaths(lefAssetsPath) {
  const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
  const paths = [];

  try {
    const stat = await fs.stat(lefAssetsPath);

    if (stat.isFile() && imageExtensions.has(path.extname(lefAssetsPath).toLowerCase())) {
      return [lefAssetsPath];
    }

    if (stat.isDirectory()) {
      const entries = await fs.readdir(lefAssetsPath, { withFileTypes: true });

      for (const entry of entries) {
        const filePath = path.join(lefAssetsPath, entry.name);

        if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
          paths.push(filePath);
        }
      }
    }
  } catch {
    // Missing folder is fine; fall back to data/lef.jpg below.
  }

  const fallbackPath = path.join(path.dirname(lefAssetsPath), 'lef.jpg');

  try {
    const fallbackStat = await fs.stat(fallbackPath);

    if (fallbackStat.isFile()) {
      paths.push(fallbackPath);
    }
  } catch {
    // No fallback image configured.
  }

  return paths;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isChatAdminRequiredError(error) {
  return error && (
    error.error_code === 400 ||
    error.errorCode === 400 ||
    error.description ||
    error.message
  ) && String(error.description || error.message || '').includes('CHAT_ADMIN_REQUIRED');
}

export {
  createBot
};
