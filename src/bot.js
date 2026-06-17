import { Bot } from 'grammy';
import { FileStore } from './store/fileStore.js';
import { AdminChecker, isGroupChat } from './services/admin.js';
import { parseAction } from './services/parser.js';
import {
  addGifFromReply,
  addStickerPackFromName,
  addStickerPackFromReply
} from './services/mediaPool.js';

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
      await handleAddStickerPack(message, action.packName);
      return;
    }

    if (action.type === 'add_gif') {
      await handleAddGif(message);
      return;
    }

    if (action.type === 'hit') {
      await handleHit(message, action.target);
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

  async function handleAddStickerPack(message, packName) {
    try {
      const result = packName
        ? await addStickerPackFromName(bot.api, store, packName)
        : await addStickerPackFromReply(bot.api, store, message);

      if (!result) {
        await bot.api.sendMessage(message.chat.id, 'Ответь на стикер или укажи имя стикерпака.');
        return;
      }

      await bot.api.sendMessage(
        message.chat.id,
        `Стикерпак ${result.setName} добавлен. Стикеров в пуле: +${result.addedCount}.`
      );
    } catch (error) {
      await bot.api.sendMessage(message.chat.id, `Не смогла добавить стикерпак: ${error.message}`);
    }
  }

  async function handleAddGif(message) {
    const result = await addGifFromReply(store, message);

    if (!result) {
      await bot.api.sendMessage(message.chat.id, 'Ответь командой на GIF/animation, которую нужно добавить.');
      return;
    }

    await bot.api.sendMessage(message.chat.id, 'GIF добавлена в арматурный пул.');
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

    const media = store.getRandomMedia();

    if (!media) {
      await bot.api.sendMessage(message.chat.id, 'Пул пустой. Админ должен добавить стикерпак или GIF.');
      return;
    }

    const options = {
      reply_to_message_id: targetMessage.messageId,
      allow_sending_without_reply: true
    };

    if (media.type === 'sticker') {
      await bot.api.sendSticker(message.chat.id, media.fileId, options);
      return;
    }

    await bot.api.sendAnimation(message.chat.id, media.fileId, options);
  }

  async function sendHelp(chatId) {
    await bot.api.sendMessage(chatId, [
      'Арматурина слушает только админов в группе.',
      '',
      'Ударить: Арматурина, дай по хрептине @username',
      'Добавить стикерпак: /addstickerpack pack_name',
      'Добавить пак из стикера: ответь на стикер фразой "Арматурина, добавь стикерпак"',
      'Добавить GIF: ответь на GIF фразой "Арматурина, добавь гифку" или /addgif',
      'Пул: /pool'
    ].join('\n'));
  }

  async function sendPoolStats(chatId) {
    const stats = store.getStats();

    await bot.api.sendMessage(
      chatId,
      `Пул: ${stats.stickerSets} стикерпаков, ${stats.stickers} стикеров, ${stats.animations} GIF.`
    );
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

export {
  createBot
};
