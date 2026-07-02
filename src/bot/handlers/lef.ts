import { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { LEF_ANIMATION_DELAY_MS, LEF_IMAGE_CHANCE } from '../../constants.ts';
import { LEF_ANIMATION_FRAMES, lefFrameText } from '../../messages.ts';
import type { LefAction, ResolvedTarget, Target } from '../../types.ts';
import { getRandomLefImage } from '../../util/lefImages.ts';
import { chance } from '../../util/random.ts';
import { delay } from '../../util/time.ts';
import type { BotDeps } from '../deps.ts';

/** "Оформить" a target: mostly a bureaucratic animation, occasionally a photo. */
export async function handleLef(deps: BotDeps, message: Message, action: LefAction): Promise<void> {
  const chatId = message.chat.id;
  const target = resolveLefTarget(deps, chatId, action.target);

  if (!target) {
    await deps.api.sendMessage(
      chatId,
      'Не нашла кому оформлять. Используй @username того, кто уже писал в группе.',
    );
    return;
  }

  if (chance(LEF_IMAGE_CHANCE)) {
    const imagePath = await getRandomLefImage(deps.config.lefAssetsPath);

    if (imagePath) {
      await deps.api.sendPhoto(chatId, new InputFile(imagePath), {
        caption: `Оформлено для ${target.label}.`,
      });
      await deps.store.recordLef(chatId, target);
      return;
    }
  }

  await playLefAnimation(deps, chatId, target, action.variant);
  await deps.store.recordLef(chatId, target);
}

function resolveLefTarget(
  deps: BotDeps,
  chatId: number,
  target: Target | null,
): ResolvedTarget | null {
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
  if (!targetMessage) {
    return {
      userId: null,
      username: target.username || null,
      label: target.label || (target.username ? `@${target.username}` : 'цель'),
    };
  }

  return {
    userId: targetMessage.userId,
    username: target.username || targetMessage.username || null,
    label: target.label || (target.username ? `@${target.username}` : `id:${targetMessage.userId}`),
  };
}

async function playLefAnimation(
  deps: BotDeps,
  chatId: number,
  target: ResolvedTarget,
  variant: string,
): Promise<void> {
  const firstFrame = LEF_ANIMATION_FRAMES[0];
  if (!firstFrame) {
    return;
  }

  const sent = await deps.api.sendMessage(chatId, lefFrameText(target, variant, firstFrame, 1));

  for (let index = 1; index < LEF_ANIMATION_FRAMES.length; index += 1) {
    const frame = LEF_ANIMATION_FRAMES[index];
    if (!frame) {
      continue;
    }

    await delay(LEF_ANIMATION_DELAY_MS);
    await deps.api.editMessageText(
      chatId,
      sent.message_id,
      lefFrameText(target, variant, frame, index + 1),
    );
  }
}
