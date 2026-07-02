import type { Api } from 'grammy';
import type { Message, ReplyParameters } from 'grammy/types';
import { pickRandom } from '../util/random.ts';

export interface ReplyOptions {
  reply_parameters: ReplyParameters;
}

/** Send options that reply to a specific message id, tolerating its deletion. */
export function replyToMessage(messageId: number): ReplyOptions {
  return { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } };
}

/** Send options that reply to the incoming message. */
export function replyToSender(message: Message): ReplyOptions {
  return replyToMessage(message.message_id);
}

/** Reply to `message` with a random line from `replies`. */
export async function sendRandomReply(
  api: Api,
  message: Message,
  replies: readonly string[],
): Promise<void> {
  await api.sendMessage(message.chat.id, pickRandom(replies), replyToSender(message));
}
