import { Bot } from 'grammy';
import { FileStore } from './store/fileStore.js';
import { AdminChecker, isGroupChat } from './services/admin.js';
import { parseAction } from './services/parser.js';
import {
  addGifFromReply,
  addStickerPackFromName,
  addStickerPackFromReply
} from './services/mediaPool.js';

const ULTRA_HIT_CHANCE = 0.01;
const ULTRA_CHARGE_STEPS = [0, 20, 40, 60, 80, 100];
const ULTRA_CHARGE_STEP_DELAY_MS = 650;

function createBot(config) {
  const bot = new Bot(config.token);
  const store = new FileStore(config.dataFilePath);
  const adminChecker = new AdminChecker(bot.api);
  let started = false;
  let pollingPromise = null;

  async function start() {
    if (started) {
      return;
    }

    await store.load();

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

    if (action.type === 'hit') {
      await handleHit(message, action.target);
    }
  }

  function isPublicAction(action) {
    return action.type === 'stats' || action.type === 'top';
  }

  async function handlePublicAction(message, action) {
    if (action.type === 'stats') {
      await sendStats(message.chat.id);
      return;
    }

    if (action.type === 'top') {
      await sendTop(message.chat.id);
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
      const result = packName
        ? await addStickerPackFromName(bot.api, store, packName, pool)
        : await addStickerPackFromReply(bot.api, store, message, pool);

      if (!result) {
        await bot.api.sendMessage(message.chat.id, 'Ответь на стикер или укажи имя стикерпака.');
        return;
      }

      await bot.api.sendMessage(
        message.chat.id,
        `Стикерпак ${result.setName} добавлен в ${getPoolLabel(pool)} пул. Стикеров: +${result.addedCount}.`
      );
    } catch (error) {
      await bot.api.sendMessage(message.chat.id, `Не смогла добавить стикерпак: ${error.message}`);
    }
  }

  async function handleAddGif(message, pool = 'regular') {
    const result = await addGifFromReply(store, message, pool);

    if (!result) {
      await bot.api.sendMessage(message.chat.id, 'Ответь командой на GIF/animation, которую нужно добавить.');
      return;
    }

    await bot.api.sendMessage(message.chat.id, `GIF добавлена в ${getPoolLabel(pool)} пул.`);
  }

  async function handleHit(message, target) {
    const targetMessage = target && target.messageId
      ? {
          messageId: target.messageId,
          userId: target.userId,
          username: target.username
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
    const media = store.getRandomMedia(isUltra ? 'ultra' : 'regular');

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
      'Пул: /pool'
    ].join('\n'));
  }

  async function sendPoolStats(chatId) {
    const stats = store.getStats();

    await bot.api.sendMessage(
      chatId,
      `Пул: ${stats.stickerSets} стикерпаков, ${stats.stickers} стикеров, ${stats.animations} GIF.\nUltra-пул: ${stats.ultraStickerSets} стикерпаков, ${stats.ultraStickers} стикеров, ${stats.ultraAnimations} GIF.`
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

function buildUltraChargeText(percent) {
  const filledCount = Math.floor(percent / 20);
  const emptyCount = 5 - filledCount;
  const bar = `${'🟩'.repeat(filledCount)}${'⬛'.repeat(emptyCount)}`;

  if (percent === 100) {
    return `${bar} ${percent}%\nЛови маслину`;
  }

  return `${bar} ${percent}%\nЗарядка мега-хрептины`;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export {
  createBot
};
