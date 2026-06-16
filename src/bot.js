const { Bot } = require('grammy');
const { FileStore } = require('./store/fileStore');
const { isChatAdmin, isGroupChat } = require('./services/admin');
const { parseAction } = require('./services/parser');
const {
  addGifFromReply,
  addStickerPackFromName,
  addStickerPackFromReply
} = require('./services/mediaPool');

function createBot(config) {
  const bot = new Bot(config.token);
  const store = new FileStore(config.dataFilePath);

  async function start() {
    await store.load();

    bot.on('message', async (ctx) => {
      await handleMessage(ctx.message);
    });

    bot.catch((error) => {
      console.error('Telegram bot error:', error.error);
    });

    console.log('Armaturina bot started.');
    await bot.start();
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
    const admin = await isChatAdmin(bot.api, message.chat.id, message.from.id);

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
      await handleHit(message, action.username);
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

  async function handleHit(message, username) {
    const targetMessage = store.getLastMessage(message.chat.id, username);

    if (!targetMessage) {
      await bot.api.sendMessage(
        message.chat.id,
        `Не нашла последнее сообщение @${username}. Сначала этот человек должен что-нибудь написать в группе.`
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
    bot,
    store
  };
}

module.exports = {
  createBot
};
