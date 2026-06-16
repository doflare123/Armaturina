async function addStickerPackFromName(api, store, packName) {
  const stickerSet = await api.getStickerSet(packName);
  const addedCount = await store.addStickerSet(stickerSet.name, stickerSet.stickers);

  return {
    setName: stickerSet.name,
    addedCount
  };
}

async function addStickerPackFromReply(api, store, message) {
  const repliedSticker = message.reply_to_message && message.reply_to_message.sticker;

  if (!repliedSticker || !repliedSticker.set_name) {
    return null;
  }

  return addStickerPackFromName(api, store, repliedSticker.set_name);
}

async function addGifFromReply(store, message) {
  const repliedMessage = message.reply_to_message;
  const animation = repliedMessage && repliedMessage.animation;

  if (!animation || !animation.file_id) {
    return null;
  }

  await store.addAnimation(animation.file_id);

  return {
    fileId: animation.file_id
  };
}

export {
  addStickerPackFromName,
  addStickerPackFromReply,
  addGifFromReply
};
