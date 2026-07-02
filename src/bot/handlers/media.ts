import type { Message } from 'grammy/types';
import {
  addGifFromReply,
  addStickerPackFromName,
  addStickerPackFromReply,
} from '../../services/ingest.ts';
import type { Pool, RetagScope } from '../../types.ts';
import { errorMessage } from '../../util/errors.ts';
import type { BotDeps } from '../deps.ts';

export async function handleAddStickerPack(
  deps: BotDeps,
  message: Message,
  packName: string | null,
  pool: Pool,
): Promise<void> {
  try {
    const tagger = deps.gemini.isEnabled() ? deps.gemini : null;
    const result = packName
      ? await addStickerPackFromName(deps.api, deps.store, packName, pool, tagger)
      : await addStickerPackFromReply(deps.api, deps.store, message, pool, tagger);

    if (!result) {
      await deps.api.sendMessage(message.chat.id, 'Ответь на стикер или укажи имя стикерпака.');
      return;
    }

    await deps.api.sendMessage(
      message.chat.id,
      `Стикерпак ${result.setName} добавлен в ${poolLabel(pool)} пул. Стикеров: +${result.addedCount}. Протегировано: ${result.taggedCount}.`,
    );
  } catch (error) {
    await deps.api.sendMessage(
      message.chat.id,
      `Не смогла добавить стикерпак: ${errorMessage(error)}`,
    );
  }
}

export async function handleAddGif(deps: BotDeps, message: Message, pool: Pool): Promise<void> {
  const tagger = deps.gemini.isEnabled() ? deps.gemini : null;
  const result = await addGifFromReply(deps.api, deps.store, message, pool, tagger);

  if (!result) {
    await deps.api.sendMessage(
      message.chat.id,
      'Ответь командой на GIF/animation, которую нужно добавить.',
    );
    return;
  }

  await deps.api.sendMessage(
    message.chat.id,
    `GIF добавлена в ${poolLabel(pool)} пул.${result.tagged ? ' Теги на месте.' : ''}`,
  );
}

export async function handleRetag(
  deps: BotDeps,
  message: Message,
  pool: RetagScope,
  limit: number,
): Promise<void> {
  if (!deps.gemini.isEnabled()) {
    await deps.api.sendMessage(
      message.chat.id,
      'Gemini выключен: укажи ARMATURINA_GEMINI_API_KEY.',
    );
    return;
  }

  const pools: Pool[] = pool === 'all' ? ['regular', 'ultra'] : [pool];
  let tagged = 0;
  let seen = 0;

  for (const currentPool of pools) {
    for (const media of deps.store.getUntaggedMedia(currentPool, limit - seen)) {
      seen += 1;

      const metadata = await deps.gemini.tagTelegramMedia(deps.api, {
        kind: media.type,
        fileId: media.fileId,
        thumbnailFileId: media.analysisFileId,
      });

      await deps.store.updateMediaMetadata(media.fileId, currentPool, metadata);

      if (metadata.tags.length > 0) {
        tagged += 1;
      }
    }
  }

  await deps.api.sendMessage(
    message.chat.id,
    `Ретег готов. Проверено: ${seen}, протегировано: ${tagged}.`,
  );
}

function poolLabel(pool: Pool): string {
  return pool === 'ultra' ? 'ultra' : 'обычный';
}
