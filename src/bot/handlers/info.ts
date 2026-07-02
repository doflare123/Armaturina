import type { Message } from 'grammy/types';
import { HELP_TEXT, PRIVATE_CHAT_REPLY } from '../../messages.ts';
import type { BotDeps } from '../deps.ts';

export async function handlePrivateMessage(deps: BotDeps, message: Message): Promise<void> {
  await deps.api.sendMessage(message.chat.id, PRIVATE_CHAT_REPLY);
}

export async function sendHelp(deps: BotDeps, chatId: number): Promise<void> {
  await deps.api.sendMessage(chatId, HELP_TEXT);
}

export async function sendPoolStats(deps: BotDeps, chatId: number): Promise<void> {
  const stats = deps.store.getStats();

  await deps.api.sendMessage(
    chatId,
    `Пул: ${stats.stickerSets} стикерпаков, ${stats.stickers} стикеров, ${stats.animations} GIF, тегов: ${stats.taggedRegular}.\n` +
      `Ultra-пул: ${stats.ultraStickerSets} стикерпаков, ${stats.ultraStickers} стикеров, ${stats.ultraAnimations} GIF, тегов: ${stats.taggedUltra}.`,
  );
}

export async function sendStats(deps: BotDeps, chatId: number): Promise<void> {
  const stats = deps.store.getChatStats(chatId);
  const leaderLine = stats.leader
    ? `Почетная хрептина недели: ${stats.leader.label} (${stats.leader.weeklyHits})`
    : 'Почетная хрептина недели пока не выбрана.';

  await deps.api.sendMessage(
    chatId,
    [
      'Арматурная статистика:',
      `Всего ударов: ${stats.totalHits}`,
      `Ультра ударов: ${stats.ultraHits}`,
      `Уникальных хрептин: ${stats.uniqueVictims}`,
      `Ударов за неделю ${stats.weekKey}: ${stats.weekHits}`,
      leaderLine,
    ].join('\n'),
  );
}

export async function sendTop(deps: BotDeps, chatId: number): Promise<void> {
  const top = deps.store.getWeeklyTop(chatId, 10);

  if (top.length === 0) {
    await deps.api.sendMessage(chatId, 'Почетная хрептина недели пока не выявлена.');
    return;
  }

  const lines = top.map((victim, index) => {
    const ultraText = victim.ultraHits > 0 ? `, ultra: ${victim.ultraHits}` : '';
    return `${index + 1}. ${victim.label} — ${victim.weeklyHits}${ultraText}`;
  });

  await deps.api.sendMessage(chatId, ['Топ недели: Почетная хрептина недели', ...lines].join('\n'));
}

export async function sendLefTop(deps: BotDeps, chatId: number): Promise<void> {
  const top = deps.store.getLefTop(chatId, 10);

  if (top.length === 0) {
    await deps.api.sendMessage(chatId, 'Змеиный топ пока пуст.');
    return;
  }

  const lines = top.map((target, index) => {
    const title = index === 0 ? ' - король змей' : '';
    return `${index + 1}. ${target.label} - ${target.total}${title}`;
  });

  await deps.api.sendMessage(chatId, ['Змеиный топ:', ...lines].join('\n'));
}
