async function addStickerPackFromName(api, store, packName, pool = 'regular', tagger = null) {
  const stickerSet = await api.getStickerSet(packName);
  const metadataByFileId = await buildStickerSetMetadata(api, stickerSet.stickers, tagger);
  const addedCount = await store.addStickerSet(stickerSet.name, stickerSet.stickers, pool, metadataByFileId);

  return {
    setName: stickerSet.name,
    addedCount,
    taggedCount: countTagged(metadataByFileId)
  };
}

async function addStickerPackFromReply(api, store, message, pool = 'regular', tagger = null) {
  const repliedSticker = message.reply_to_message && message.reply_to_message.sticker;

  if (!repliedSticker || !repliedSticker.set_name) {
    return null;
  }

  return addStickerPackFromName(api, store, repliedSticker.set_name, pool, tagger);
}

async function addGifFromReply(api, store, message, pool = 'regular', tagger = null) {
  const repliedMessage = message.reply_to_message;
  const animation = repliedMessage && repliedMessage.animation;

  if (!animation || !animation.file_id) {
    return null;
  }

  const metadata = tagger
    ? await tagger.tagTelegramMedia(api, buildAnimationDescriptor(animation))
    : buildBaseMediaMetadata(buildAnimationDescriptor(animation));

  await store.addAnimation(animation.file_id, pool, metadata);

  return {
    fileId: animation.file_id,
    tagged: metadata.tags && metadata.tags.length > 0
  };
}

async function buildStickerSetMetadata(api, stickers, tagger) {
  const metadataByFileId = new Map();
  const maxTags = tagger ? tagger.maxTagsPerPack : 0;

  for (const sticker of stickers) {
    metadataByFileId.set(sticker.file_id, buildBaseMediaMetadata(buildStickerDescriptor(sticker)));
  }

  if (!tagger) {
    return metadataByFileId;
  }

  for (const sticker of stickers.slice(0, maxTags)) {
    const descriptor = buildStickerDescriptor(sticker);
    metadataByFileId.set(sticker.file_id, await tagger.tagTelegramMedia(api, descriptor));
  }

  return metadataByFileId;
}

function buildStickerDescriptor(sticker) {
  return {
    kind: 'sticker',
    fileId: sticker.file_id,
    thumbnailFileId: sticker.thumbnail && sticker.thumbnail.file_id,
    isAnimated: Boolean(sticker.is_animated),
    isVideo: Boolean(sticker.is_video)
  };
}

function buildAnimationDescriptor(animation) {
  return {
    kind: 'animation',
    fileId: animation.file_id,
    thumbnailFileId: animation.thumbnail && animation.thumbnail.file_id,
    isAnimated: true,
    isVideo: true
  };
}

function buildBaseMediaMetadata(descriptor) {
  return {
    tags: [],
    mood: null,
    caption: null,
    analysisFileId: descriptor.thumbnailFileId || descriptor.fileId,
    analysisMimeType: null,
    taggedAt: null
  };
}

function countTagged(metadataByFileId) {
  return [...metadataByFileId.values()].filter((metadata) => metadata.tags && metadata.tags.length > 0).length;
}

export {
  addStickerPackFromName,
  addStickerPackFromReply,
  addGifFromReply,
  buildStickerDescriptor,
  buildAnimationDescriptor
};
