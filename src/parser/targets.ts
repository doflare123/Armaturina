import type { Message } from 'grammy/types';
import type { Target } from '../types.ts';
import { USERNAME_RE } from './patterns.ts';

export function getMessageText(message: Pick<Message, 'text' | 'caption'>): string {
  return message.text || message.caption || '';
}

/** Target from an explicit mention (entity or `@username`) in `searchText`. */
export function extractMentionTarget(
  message: Message,
  text: string,
  searchText: string = text,
): Target | null {
  const entityTarget = extractMentionTargetFromEntities(message, text);
  if (entityTarget) {
    return entityTarget;
  }

  const username = searchText.match(USERNAME_RE)?.[1];
  if (!username) {
    return null;
  }

  return { username, label: `@${username}` };
}

function extractMentionTargetFromEntities(message: Message, text: string): Target | null {
  const entities = message.entities || message.caption_entities || [];

  for (const entity of entities) {
    if (entity.type === 'text_mention' && entity.user) {
      return {
        userId: entity.user.id,
        username: entity.user.username || null,
        label: entity.user.username ? `@${entity.user.username}` : entity.user.first_name,
      };
    }

    if (entity.type === 'mention') {
      const mention = text.slice(entity.offset, entity.offset + entity.length);
      const username = mention.match(USERNAME_RE)?.[1];

      if (username) {
        return { username, label: `@${username}` };
      }
    }
  }

  return null;
}

/** Target from the message this command replied to. */
export function extractReplyTarget(message: Message): Target | null {
  const reply = message.reply_to_message;
  if (!reply?.from) {
    return null;
  }

  return {
    userId: reply.from.id,
    username: reply.from.username || null,
    messageId: reply.message_id,
    text: getMessageText(reply),
    label: reply.from.username ? `@${reply.from.username}` : reply.from.first_name,
  };
}

/** The command sender, used as the implicit target of `lef` phrases. */
export function buildSelfTarget(message: Message): Target | null {
  if (!message.from) {
    return null;
  }

  return {
    userId: message.from.id,
    username: message.from.username || null,
    label: message.from.username ? `@${message.from.username}` : message.from.first_name,
  };
}
