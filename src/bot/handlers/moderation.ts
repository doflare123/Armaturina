import type { Message } from 'grammy/types';
import { MUTE_PERMISSIONS, NON_ADMIN_MUTE_ESCALATION_MINUTES } from '../../constants.ts';
import { NON_ADMIN_MUTE_PUNISHMENTS, NON_ADMIN_MUTE_WARNINGS } from '../../messages.ts';
import type { BanAction, ModerationTarget, MuteAction, Target } from '../../types.ts';
import { errorMessage } from '../../util/errors.ts';
import { pickRandom } from '../../util/random.ts';
import { formatDuration } from '../../util/time.ts';
import type { BotDeps } from '../deps.ts';
import { replyToSender, sendRandomReply } from '../replies.ts';
import {
  canBotModerate,
  canModerateTarget,
  isChatAdminRequiredError,
  isTargetAdminError,
  sendTargetAdminError,
} from '../telegram.ts';

export async function handleMute(
  deps: BotDeps,
  message: Message,
  action: MuteAction,
): Promise<void> {
  const chatId = message.chat.id;

  if (!action.minutes) {
    await deps.api.sendMessage(
      chatId,
      'Сколько минут заваривать-то? Напиши /mute 10 ответом или /mute @username 10.',
    );
    return;
  }

  const target = resolveModerationTarget(deps, chatId, action.target);
  if (!target) {
    await deps.api.sendMessage(
      chatId,
      'Не нашла кого мутить. Ответь командой на сообщение человека или используй @username того, кто уже писал в группе.',
    );
    return;
  }

  if (!(await canBotModerate(deps, chatId))) {
    await deps.api.sendMessage(
      chatId,
      'Не могу мутить: сделай бота админом и включи ему право банить/ограничивать участников.',
    );
    return;
  }

  if (!(await canModerateTarget(deps, chatId, target, 'замутить'))) {
    return;
  }

  const untilDate = Math.floor(Date.now() / 1000) + action.minutes * 60;

  try {
    await deps.api.restrictChatMember(chatId, target.userId, MUTE_PERMISSIONS, {
      until_date: untilDate,
    });
    await deps.api.sendMessage(
      chatId,
      `Заварила ебало ${target.label} на ${formatDuration(action.minutes)}.`,
    );
  } catch (error) {
    if (isTargetAdminError(error)) {
      await sendTargetAdminError(deps.api, chatId, target, 'замутить');
      return;
    }

    if (isChatAdminRequiredError(error)) {
      await deps.api.sendMessage(
        chatId,
        'Telegram не дал замутить: у бота нет админского права банить/ограничивать участников.',
      );
      return;
    }

    await deps.api.sendMessage(
      chatId,
      `Не смогла замутить ${target.label}: ${errorMessage(error)}`,
    );
  }
}

export async function handleBan(deps: BotDeps, message: Message, action: BanAction): Promise<void> {
  const chatId = message.chat.id;
  const target = resolveModerationTarget(deps, chatId, action.target);

  if (!target) {
    await deps.api.sendMessage(
      chatId,
      'Не нашла кого банить. Ответь командой на сообщение человека или используй @username того, кто уже писал в группе.',
    );
    return;
  }

  if (!(await canBotModerate(deps, chatId))) {
    await deps.api.sendMessage(
      chatId,
      'Не могу банить: сделай бота админом и включи ему право банить/ограничивать участников.',
    );
    return;
  }

  if (!(await canModerateTarget(deps, chatId, target, 'забанить'))) {
    return;
  }

  try {
    await deps.api.banChatMember(chatId, target.userId, { revoke_messages: true });
    await deps.api.sendMessage(chatId, `Уебала ${target.label} из чата.`);
  } catch (error) {
    if (isTargetAdminError(error)) {
      await sendTargetAdminError(deps.api, chatId, target, 'забанить');
      return;
    }

    if (isChatAdminRequiredError(error)) {
      await deps.api.sendMessage(
        chatId,
        'Telegram не дал забанить: у бота нет админского права банить/ограничивать участников.',
      );
      return;
    }

    await deps.api.sendMessage(
      chatId,
      `Не смогла забанить ${target.label}: ${errorMessage(error)}`,
    );
  }
}

export async function handleUnauthorizedMute(deps: BotDeps, message: Message): Promise<void> {
  const chatId = message.chat.id;

  if (!message.from) {
    await sendRandomReply(deps.api, message, NON_ADMIN_MUTE_WARNINGS);
    return;
  }

  const attempt = await deps.store.recordModerationAbuse(chatId, message.from);
  if (attempt.count === 1) {
    await sendRandomReply(deps.api, message, NON_ADMIN_MUTE_WARNINGS);
    return;
  }

  const minutes = getUnauthorizedMuteMinutes(attempt.count);

  if (!(await canBotModerate(deps, chatId))) {
    await deps.api.sendMessage(
      chatId,
      'Я бы тебе уже заварила ебальник, но мне не дали право ограничивать участников. Считай, что сегодня пронесло.',
      replyToSender(message),
    );
    return;
  }

  const untilDate = Math.floor(Date.now() / 1000) + minutes * 60;

  try {
    await deps.api.restrictChatMember(chatId, message.from.id, MUTE_PERMISSIONS, {
      until_date: untilDate,
    });
    await deps.api.sendMessage(
      chatId,
      `${pickRandom(NON_ADMIN_MUTE_PUNISHMENTS)} Мут на ${minutes} мин.`,
      replyToSender(message),
    );
  } catch (error) {
    await deps.api.sendMessage(
      chatId,
      `Хотела заварить, но Telegram не дал: ${errorMessage(error)}`,
      replyToSender(message),
    );
  }
}

function resolveModerationTarget(
  deps: BotDeps,
  chatId: number,
  target: Target | null,
): ModerationTarget | null {
  if (!target) {
    return null;
  }

  if (target.userId) {
    return {
      userId: target.userId,
      username: target.username || null,
      label: target.label || (target.username ? `@${target.username}` : `id:${target.userId}`),
    };
  }

  const targetMessage = deps.store.getLastMessage(chatId, target);
  if (!targetMessage?.userId) {
    return null;
  }

  const username = target.username || targetMessage.username || null;

  return {
    userId: targetMessage.userId,
    username,
    label: target.label || (username ? `@${username}` : `id:${targetMessage.userId}`),
  };
}

function getUnauthorizedMuteMinutes(attemptCount: number): number {
  const index = Math.max(0, attemptCount - 2);
  const clamped = Math.min(index, NON_ADMIN_MUTE_ESCALATION_MINUTES.length - 1);

  return NON_ADMIN_MUTE_ESCALATION_MINUTES.at(clamped) ?? 30;
}
