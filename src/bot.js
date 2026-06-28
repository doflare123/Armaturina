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
const NON_ADMIN_MUTE_ESCALATION_MINUTES = [3, 5, 10, 15, 30];
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
const NON_ADMIN_BAN_REPLIES = [
  'Уебалка еще не выросла. Сиди ровно, гроза песочницы.',
  'Ты херли хулиганишь? Мне твоей маме позвонить или сам угомонишься?',
  'Командовать банами будешь, когда штаны до админки дорастут.',
  'Не дорос ты до кнопки "уеби". Максимум можешь уебать себя в настройки.',
  'У тебя прав на бан меньше, чем терпения у Арматурины утром.',
  'Положи банхаммер обратно, богатырь картонный.'
];
const NON_ADMIN_HIT_REPLIES = [
  'Фаскать будешь, когда админка прорежется. А пока сиди на лавочке запасных.',
  'Арматурина посмотрела на твои права и нашла там дырку от бублика.',
  'Ты сейчас так уверенно командуешь, будто у тебя не пластиковый бейджик из детского меню.',
  'Не могу пиздануть по твоей заявке: уровень допуска "мам, можно?".',
  'Команда принята, уважение не найдено, админка отсутствует.',
  'Хрептинатор доступен только старшим по подъезду. Ты пока младший по коврику.',
  'Ты кого натравить собрался, кнопочный самурай без кнопок?',
  'Арматурина без админского жетона не кусает. Максимум презрительно хрюкает.',
  'Запрос отклонен: у заявителя прав меньше, чем сдачи в маршрутке.',
  'Сначала стань админом, потом размахивай арматурой, терминатор с авито.'
];
const NON_ADMIN_MUTE_WARNINGS = [
  'Я щас тебе заварю ебальник, если ты не прекратишь.',
  'Еще раз дернешь мут без админки - будешь молчать и думать о вечном.',
  'Не трогай мут, пока лапки админские не выросли.',
  'Смотри аккуратнее, а то сейчас ебальник на техобслуживание уйдет.',
  'Хулиганский пульт от мута у тебя бутафорский. Не нажимай.'
];
const NON_ADMIN_MUTE_PUNISHMENTS = [
  'Подумай о своем поведении, в следующий раз позвоню твоей маме.',
  'Заварила. Сиди тихо и перечитывай инструкцию "как не быть дерзким".',
  'Ебальник закрыт на профилактику. Дыши носом, герой.',
  'Мут оформлен. Не благодари, это воспитательная медицина.',
  'Отправляю тебя в режим радиомолчания. Возвращайся с нормальным лицом.'
];

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
      await handleUnauthorizedAdminAction(message, action);
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

  async function handleUnauthorizedAdminAction(message, action) {
    if (action.type === 'hit') {
      await sendRandomReply(bot.api, message, NON_ADMIN_HIT_REPLIES);
      return;
    }

    if (action.type === 'ban') {
      await sendRandomReply(bot.api, message, NON_ADMIN_BAN_REPLIES);
      return;
    }

    if (action.type === 'mute') {
      await handleUnauthorizedMute(message);
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
    if (!action.minutes) {
      await bot.api.sendMessage(
        message.chat.id,
        'Сколько минут заваривать-то? Напиши /mute 10 ответом или /mute @username 10.'
      );
      return;
    }

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

    if (!await canModerateTarget(message.chat.id, target, 'замутить')) {
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
        `Заварила ебало ${target.label} на ${formatDuration(action.minutes)}.`
      );
    } catch (error) {
      if (isTargetAdminError(error)) {
        await sendTargetAdminError(message.chat.id, target, 'замутить');
        return;
      }

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

    if (!await canModerateTarget(message.chat.id, target, 'забанить')) {
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
      if (isTargetAdminError(error)) {
        await sendTargetAdminError(message.chat.id, target, 'забанить');
        return;
      }

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

  async function handleUnauthorizedMute(message) {
    if (!message.from) {
      await sendRandomReply(bot.api, message, NON_ADMIN_MUTE_WARNINGS);
      return;
    }

    const attempt = await store.recordModerationAbuse(message.chat.id, message.from);

    if (attempt.count === 1) {
      await sendRandomReply(bot.api, message, NON_ADMIN_MUTE_WARNINGS);
      return;
    }

    const minutes = getUnauthorizedMuteMinutes(attempt.count);

    if (!await canBotModerate(message.chat.id)) {
      await bot.api.sendMessage(
        message.chat.id,
        'Я бы тебе уже заварила ебальник, но мне не дали право ограничивать участников. Считай, что сегодня пронесло.',
        buildReplyOptions(message)
      );
      return;
    }

    const untilDate = Math.floor(Date.now() / 1000) + minutes * 60;

    try {
      await bot.api.restrictChatMember(
        message.chat.id,
        message.from.id,
        MUTE_PERMISSIONS,
        { until_date: untilDate }
      );

      await bot.api.sendMessage(
        message.chat.id,
        `${pickRandom(NON_ADMIN_MUTE_PUNISHMENTS)} Мут на ${minutes} мин.`,
        buildReplyOptions(message)
      );
    } catch (error) {
      await bot.api.sendMessage(
        message.chat.id,
        `Хотела заварить, но Telegram не дал: ${error.message}`,
        buildReplyOptions(message)
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

  async function canModerateTarget(chatId, target, actionName) {
    try {
      const member = await bot.api.getChatMember(chatId, target.userId);

      if (member.status === 'creator' || member.status === 'administrator') {
        await sendTargetAdminError(chatId, target, actionName);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to check moderation target:', error);
      return true;
    }
  }

  async function sendTargetAdminError(chatId, target, actionName) {
    await bot.api.sendMessage(
      chatId,
      `Не могу ${actionName} ${target.label}: Telegram не дает боту трогать админов и владельца чата. Сначала сними с него админку, потом зовите Арматурину с арматурой.`
    );
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
      'Мут: ответь /mute 10, /mute 2ч, /mute 1д или напиши /mute @username 2 часа',
      'Мут фразой: Арматурина завари ебало на 10 минут / 2 часа / 1 день',
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

async function sendRandomReply(api, message, replies) {
  await api.sendMessage(
    message.chat.id,
    pickRandom(replies),
    buildReplyOptions(message)
  );
}

function buildReplyOptions(message) {
  return {
    reply_to_message_id: message.message_id,
    allow_sending_without_reply: true
  };
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function getUnauthorizedMuteMinutes(attemptCount) {
  const index = Math.max(0, attemptCount - 2);

  return NON_ADMIN_MUTE_ESCALATION_MINUTES[
    Math.min(index, NON_ADMIN_MUTE_ESCALATION_MINUTES.length - 1)
  ];
}

function formatDuration(minutes) {
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;

    return `${days} ${pluralizeRu(days, ['день', 'дня', 'дней'])}`;
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;

    return `${hours} ${pluralizeRu(hours, ['час', 'часа', 'часов'])}`;
  }

  return `${minutes} ${pluralizeRu(minutes, ['минуту', 'минуты', 'минут'])}`;
}

function pluralizeRu(value, forms) {
  const absValue = Math.abs(value);
  const lastTwo = absValue % 100;
  const last = absValue % 10;

  if (lastTwo >= 11 && lastTwo <= 14) {
    return forms[2];
  }

  if (last === 1) {
    return forms[0];
  }

  if (last >= 2 && last <= 4) {
    return forms[1];
  }

  return forms[2];
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

function isTargetAdminError(error) {
  const text = getTelegramErrorText(error).toLowerCase();

  return text.includes('user is an administrator of the chat') ||
    text.includes('user_admin_invalid') ||
    text.includes('not enough rights to restrict') ||
    text.includes('not enough rights to ban') ||
    text.includes("can't restrict") ||
    text.includes("can't ban");
}

function getTelegramErrorText(error) {
  return String(error?.description || error?.message || '');
}

export {
  createBot
};
