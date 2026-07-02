import type { Api } from 'grammy';
import type { Animation, Message, Sticker } from 'grammy/types';
import type { MemoryStore } from '../store/memoryStore.ts';
import type { MediaDescriptor, MediaMetadata, MediaTagger, Pool } from '../types.ts';

export interface AddPackResult {
  setName: string;
  addedCount: number;
  taggedCount: number;
}

export interface AddGifResult {
  fileId: string;
  tagged: boolean;
}

/** Fetch a sticker set by name and add every sticker to the pool. */
export async function addStickerPackFromName(
  api: Api,
  store: MemoryStore,
  packName: string,
  pool: Pool = 'regular',
  tagger: MediaTagger | null = null,
): Promise<AddPackResult> {
  const stickerSet = await api.getStickerSet(packName);
  const metadataByFileId = await buildStickerSetMetadata(api, stickerSet.stickers, tagger);
  const addedCount = await store.addStickerSet(
    stickerSet.name,
    stickerSet.stickers,
    pool,
    metadataByFileId,
  );

  return { setName: stickerSet.name, addedCount, taggedCount: countTagged(metadataByFileId) };
}

/** Add the set that the replied-to sticker belongs to, if any. */
export async function addStickerPackFromReply(
  api: Api,
  store: MemoryStore,
  message: Message,
  pool: Pool = 'regular',
  tagger: MediaTagger | null = null,
): Promise<AddPackResult | null> {
  const setName = message.reply_to_message?.sticker?.set_name;
  if (!setName) {
    return null;
  }

  return addStickerPackFromName(api, store, setName, pool, tagger);
}

/** Add the replied-to GIF/animation to the pool. */
export async function addGifFromReply(
  api: Api,
  store: MemoryStore,
  message: Message,
  pool: Pool = 'regular',
  tagger: MediaTagger | null = null,
): Promise<AddGifResult | null> {
  const animation = message.reply_to_message?.animation;
  if (!animation?.file_id) {
    return null;
  }

  const descriptor = buildAnimationDescriptor(animation);
  const metadata = tagger
    ? await tagger.tagTelegramMedia(api, descriptor)
    : buildBaseMetadata(descriptor);

  await store.addAnimation(animation.file_id, pool, metadata);

  return { fileId: animation.file_id, tagged: metadata.tags.length > 0 };
}

async function buildStickerSetMetadata(
  api: Api,
  stickers: Sticker[],
  tagger: MediaTagger | null,
): Promise<Map<string, MediaMetadata>> {
  const metadataByFileId = new Map<string, MediaMetadata>();

  for (const sticker of stickers) {
    metadataByFileId.set(sticker.file_id, buildBaseMetadata(buildStickerDescriptor(sticker)));
  }

  if (!tagger) {
    return metadataByFileId;
  }

  for (const sticker of stickers.slice(0, tagger.maxTagsPerPack)) {
    metadataByFileId.set(
      sticker.file_id,
      await tagger.tagTelegramMedia(api, buildStickerDescriptor(sticker)),
    );
  }

  return metadataByFileId;
}

export function buildStickerDescriptor(sticker: Sticker): MediaDescriptor {
  return {
    kind: 'sticker',
    fileId: sticker.file_id,
    thumbnailFileId: sticker.thumbnail?.file_id,
    isAnimated: Boolean(sticker.is_animated),
    isVideo: Boolean(sticker.is_video),
  };
}

export function buildAnimationDescriptor(animation: Animation): MediaDescriptor {
  return {
    kind: 'animation',
    fileId: animation.file_id,
    thumbnailFileId: animation.thumbnail?.file_id,
    isAnimated: true,
    isVideo: true,
  };
}

function buildBaseMetadata(descriptor: MediaDescriptor): MediaMetadata {
  return {
    tags: [],
    mood: null,
    caption: null,
    analysisFileId: descriptor.thumbnailFileId || descriptor.fileId,
    analysisMimeType: null,
    taggedAt: null,
  };
}

function countTagged(metadataByFileId: Map<string, MediaMetadata>): number {
  return [...metadataByFileId.values()].filter((metadata) => metadata.tags.length > 0).length;
}
