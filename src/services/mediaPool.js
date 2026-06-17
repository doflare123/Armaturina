async function addStickerPackFromName(api, store, packName, pool = 'regular') {
  const stickerSet = await api.getStickerSet(packName);
  const addedCount = await store.addStickerSet(stickerSet.name, stickerSet.stickers, pool);

  return {
    setName: stickerSet.name,
    addedCount
  };
}

async function addStickerPackFromReply(api, store, message, pool = 'regular') {
  const repliedSticker = message.reply_to_message && message.reply_to_message.sticker;

  if (!repliedSticker || !repliedSticker.set_name) {
    return null;
  }

  return addStickerPackFromName(api, store, repliedSticker.set_name, pool);
}

async function addGifFromReply(store, message, pool = 'regular') {
  const repliedMessage = message.reply_to_message;
  const animation = repliedMessage && repliedMessage.animation;

  if (!animation || !animation.file_id) {
    return null;
  }

  await store.addAnimation(animation.file_id, pool);

  return {
    fileId: animation.file_id
  };
}

export {
  addStickerPackFromName,
  addStickerPackFromReply,
  addGifFromReply
};
