import type { Message } from 'grammy/types';
import {
  ULTRA_CHARGE_STEP_DELAY_MS,
  ULTRA_CHARGE_STEPS,
  ULTRA_HIT_CHANCE,
} from '../../constants.ts';
import { ultraChargeText } from '../../messages.ts';
import type { ResolvedTarget, Target } from '../../types.ts';
import { chance } from '../../util/random.ts';
import { delay } from '../../util/time.ts';
import type { BotDeps } from '../deps.ts';
import { type ReplyOptions, replyToMessage } from '../replies.ts';

interface HitTargetMessage {
  messageId: number;
  userId: number | null;
  username: string | null;
  text: string;
}

/** Reply to the target's last message with a (possibly ultra) sticker/GIF. */
export async function handleHit(deps: BotDeps, message: Message, target: Target): Promise<void> {
  const chatId = message.chat.id;
  const targetMessage = resolveHitMessage(deps, chatId, target);
  const targetLabel = target.label || 'цели';

  if (!targetMessage) {
    await deps.api.sendMessage(
      chatId,
      `Не нашла последнее сообщение ${targetLabel}. Сначала этот человек должен что-нибудь написать в группе.`,
    );
    return;
  }

  const isUltra = chance(ULTRA_HIT_CHANCE) && deps.store.hasMedia('ultra');
  const pool = isUltra ? 'ultra' : 'regular';
  const wantedTags = await deps.gemini.selectTagsForContext(
    getHitContextText(message, targetMessage),
  );
  const media = deps.store.getBestMediaByTags(pool, wantedTags) ?? deps.store.getRandomMedia(pool);

  if (!media) {
    await deps.api.sendMessage(chatId, 'Пул пустой. Админ должен добавить стикерпак или GIF.');
    return;
  }

  const options = replyToMessage(targetMessage.messageId);

  if (isUltra) {
    await playUltraCharge(deps, chatId, options);
  }

  if (media.type === 'sticker') {
    await deps.api.sendSticker(chatId, media.fileId, options);
  } else {
    await deps.api.sendAnimation(chatId, media.fileId, options);
  }

  await deps.store.recordHit(chatId, buildStatsTarget(target, targetMessage), isUltra);
}

function resolveHitMessage(deps: BotDeps, chatId: number, target: Target): HitTargetMessage | null {
  if (target.messageId) {
    return {
      messageId: target.messageId,
      userId: target.userId ?? null,
      username: target.username ?? null,
      text: target.text || '',
    };
  }

  return deps.store.getLastMessage(chatId, target);
}

function buildStatsTarget(target: Target, targetMessage: HitTargetMessage): ResolvedTarget {
  const username = target.username || targetMessage.username || null;
  const userId = target.userId || targetMessage.userId || null;

  return {
    userId,
    username,
    label: target.label || (username ? `@${username}` : `id:${userId}`),
  };
}

function getHitContextText(message: Message, targetMessage: HitTargetMessage): string {
  return (
    targetMessage.text ||
    message.reply_to_message?.text ||
    message.reply_to_message?.caption ||
    message.text ||
    message.caption ||
    ''
  );
}

async function playUltraCharge(
  deps: BotDeps,
  chatId: number,
  options: ReplyOptions,
): Promise<void> {
  let chargeMessage: { message_id: number } | null = null;

  try {
    chargeMessage = await deps.api.sendMessage(chatId, ultraChargeText(0), options);

    for (const percent of ULTRA_CHARGE_STEPS.slice(1)) {
      await delay(ULTRA_CHARGE_STEP_DELAY_MS);
      await deps.api.editMessageText(chatId, chargeMessage.message_id, ultraChargeText(percent));
    }

    await delay(ULTRA_CHARGE_STEP_DELAY_MS);
    await deps.api.deleteMessage(chatId, chargeMessage.message_id);
  } catch (error) {
    console.error('Failed to play ultra charge animation:', error);

    if (chargeMessage) {
      await deps.api.deleteMessage(chatId, chargeMessage.message_id).catch(() => {});
    }
  }
}
