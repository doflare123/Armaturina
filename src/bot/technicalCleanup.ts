import type { Api } from 'grammy';
import type { Message } from 'grammy/types';

export const TECHNICAL_CLEANUP_MS = 15_000;

/** Only explicitly supplied service-message IDs are eligible. Never follows reply targets. */
export class TechnicalCleanup {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private readonly api: Pick<Api, 'deleteMessage'>;
  constructor(api: Pick<Api, 'deleteMessage'>) {
    this.api = api;
  }

  schedule(chatId: number, ...messageIds: Array<number | null | undefined>) {
    if (this.closed) return;
    for (const id of messageIds) {
      if (!Number.isSafeInteger(id) || !id || id < 1) continue;
      const key = `${chatId}:${id}`;
      if (this.timers.has(key)) continue;
      const timer = setTimeout(() => {
        this.timers.delete(key);
        // Telegram may reject deletion if rights changed or the message is already gone.
        void Promise.resolve()
          .then(() => this.api.deleteMessage(chatId, id))
          .catch(() => {});
      }, TECHNICAL_CLEANUP_MS);
      timer.unref?.();
      this.timers.set(key, timer);
    }
  }

  close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export function isTechnicalCommand(message: Message, botUsername: string): boolean {
  if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') return false;
  const match =
    /^\/(arm_help|help|pool|stats|top|lef_top|snake_top|retag|addstickerpack|addultrastickerpack|addgif|addultragif|mute|ban)(?:@([a-z0-9_]+))?(?=\s|$)/iu.exec(
      message.text ?? '',
    );
  return !!match && (!match[2] || match[2].toLowerCase() === botUsername.toLowerCase());
}

/** Scope response tracking to one command, safe across concurrent chats. */
export async function withTechnicalCleanup(
  api: Api,
  cleanup: TechnicalCleanup,
  message: Message,
  action: (api: Api) => Promise<void>,
): Promise<void> {
  const ids = [message.message_id];
  const scoped = new Proxy(api, {
    get(target, property) {
      if (property === 'sendMessage')
        return async (...args: Parameters<Api['sendMessage']>) => {
          const response = await target.sendMessage(...args);
          if (args[0] === message.chat.id && response?.message_id) ids.push(response.message_id);
          return response;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await action(scoped);
  } finally {
    cleanup.schedule(message.chat.id, ...ids);
  }
}
