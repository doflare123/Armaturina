const ARMATURINA_RE = /(?<![\p{L}\p{N}_])арматур[\p{L}\p{N}_]*(?![\p{L}\p{N}_])/iu;
const USERNAME_RE = /@([a-zA-Z0-9_]{5,32})/;

function getMessageText(message) {
  return message.text || message.caption || '';
}

function hasArmaturina(text) {
  return ARMATURINA_RE.test(text);
}

function parseAction(message) {
  const text = getMessageText(message).trim();
  const lowerText = text.toLowerCase();

  if (lowerText.startsWith('/arm_help') || lowerText.startsWith('/help')) {
    return { type: 'help' };
  }

  if (lowerText.startsWith('/pool')) {
    return { type: 'pool' };
  }

  if (lowerText.startsWith('/addgif')) {
    return { type: 'add_gif' };
  }

  if (lowerText.startsWith('/addstickerpack')) {
    return {
      type: 'add_sticker_pack',
      packName: text.split(/\s+/)[1] || null
    };
  }

  if (!hasArmaturina(text)) {
    return { type: 'none' };
  }

  if (isAddGifText(lowerText)) {
    return { type: 'add_gif' };
  }

  if (isAddStickerPackText(lowerText)) {
    return {
      type: 'add_sticker_pack',
      packName: extractStickerPackName(text)
    };
  }

  const mentionTarget = extractMentionTarget(message, text);

  if (mentionTarget) {
    return {
      type: 'hit',
      target: mentionTarget
    };
  }

  const replyTarget = extractReplyTarget(message);

  if (replyTarget) {
    return {
      type: 'hit',
      target: replyTarget
    };
  }

  return { type: 'none' };
}

function extractMentionTarget(message, text) {
  const entityTarget = extractMentionTargetFromEntities(message, text);

  if (entityTarget) {
    return entityTarget;
  }

  const usernameMatch = text.match(USERNAME_RE);

  if (!usernameMatch) {
    return null;
  }

  return {
    type: 'username',
    username: usernameMatch[1],
    label: `@${usernameMatch[1]}`
  };
}

function extractMentionTargetFromEntities(message, text) {
  const entities = message.entities || message.caption_entities || [];

  for (const entity of entities) {
    if (entity.type === 'text_mention' && entity.user) {
      return {
        type: 'user_id',
        userId: entity.user.id,
        username: entity.user.username || null,
        label: entity.user.username ? `@${entity.user.username}` : entity.user.first_name
      };
    }

    if (entity.type === 'mention') {
      const mention = text.slice(entity.offset, entity.offset + entity.length);
      const usernameMatch = mention.match(USERNAME_RE);

      if (usernameMatch) {
        return {
          type: 'username',
          username: usernameMatch[1],
          label: `@${usernameMatch[1]}`
        };
      }
    }
  }

  return null;
}

function extractReplyTarget(message) {
  const reply = message.reply_to_message;

  if (!reply || !reply.from) {
    return null;
  }

  return {
    type: 'reply',
    userId: reply.from.id,
    username: reply.from.username || null,
    messageId: reply.message_id,
    label: reply.from.username ? `@${reply.from.username}` : reply.from.first_name
  };
}

function isAddGifText(lowerText) {
  return lowerText.includes('добав') && (lowerText.includes('гиф') || lowerText.includes('gif'));
}

function isAddStickerPackText(lowerText) {
  return lowerText.includes('добав') && (
    lowerText.includes('стикерпак') ||
    lowerText.includes('стикер пак') ||
    lowerText.includes('пак')
  );
}

function extractStickerPackName(text) {
  const words = text
    .replace(/[,\n\r]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  // Telegram sticker set names are latin identifiers, usually ending with "_by_<bot>".
  const possiblePackNames = words.filter((word) => /^[a-zA-Z0-9_]{2,64}$/.test(word));

  return possiblePackNames[possiblePackNames.length - 1] || null;
}

export {
  getMessageText,
  parseAction
};
