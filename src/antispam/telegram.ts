import type { Api } from 'grammy';
import type { CallbackQuery, Message } from 'grammy/types';
import type { SpamConfig } from './config.ts';
import { SpamStore, type Verdict } from './store.ts';

/** Manual LEARNING adapter. No classifier, external AI, or automatic punishment. */
export class SpamTelegram {
  private readonly api: Api;
  private readonly config: SpamConfig;
  readonly store: SpamStore;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(api: Api, config: SpamConfig) {
    this.api = api;
    this.config = config;
    this.store = new SpamStore(config.databasePath);
    this.store.prune(config.retentionDays);
    this.timer = setInterval(() => {
      try {
        this.store.prune(config.retentionDays);
      } catch {
        console.error('antispam_maintenance_failed');
      }
    }, 60_000);
    this.timer.unref();
  }

  private enabled(message: Message): boolean {
    return (
      (message.chat.type === 'group' || message.chat.type === 'supergroup') &&
      this.config.chatIds.includes(message.chat.id)
    );
  }

  private async isAdmin(chatId: number, userId: number): Promise<boolean> {
    try {
      const member = await this.api.getChatMember(chatId, userId);
      return member.status === 'creator' || member.status === 'administrator';
    } catch {
      return false;
    }
  }

  edited(message: Message) {
    if (this.enabled(message)) this.store.invalidateEdited(message);
  }

  async message(message: Message, botUsername: string): Promise<boolean> {
    if (!this.enabled(message)) return false;
    const command = /^\/spam(?:@([a-z0-9_]+))?(?:\s+(.*))?$/iu.exec(message.text ?? '');
    if (!command) {
      if (!message.from?.is_bot || message.sender_chat) this.store.capture(message);
      return false;
    }
    if (command[1] && command[1].toLowerCase() !== botUsername.toLowerCase()) return true;
    // Anonymous admins cannot provide attributable training labels.
    if (
      message.sender_chat ||
      !message.from ||
      !(await this.isAdmin(message.chat.id, message.from.id))
    ) {
      await this.api.sendMessage(
        message.chat.id,
        'Разметка доступна администратору от личного аккаунта.',
      );
      return true;
    }
    const arg = command[2]?.trim() ?? 'status';
    if (arg === 'status' || arg === 'stats') {
      const stats = this.store.stats(message.chat.id);
      await this.api.sendMessage(
        message.chat.id,
        `Антиспам: LEARNING, модель: COLD_START. Автоудаление отключено.\nСообщений: ${stats?.messages}\nУникальных spam: ${stats?.spam}\nУникальных normal: ${stats?.normal}\nОжидают решения: ${stats?.pending}`,
      );
      return true;
    }
    if (arg.startsWith('undo ')) {
      const id = arg.slice(5).trim();
      const item = this.store.getCase(id);
      const done = item?.chat_id === message.chat.id && this.store.undo(id, message.from.id);
      await this.api.sendMessage(
        message.chat.id,
        done
          ? 'Разметка отменена. Удалённое сообщение восстановить нельзя.'
          : 'Решение не найдено или уже отменено.',
      );
      return true;
    }
    if (arg !== 'review' || !message.reply_to_message) {
      await this.api.sendMessage(
        message.chat.id,
        '/spam review — ответом на сообщение для разметки.\n/spam status\n/spam stats\n/spam undo <id решения>',
      );
      return true;
    }
    const target = message.reply_to_message;
    if (target.chat.id !== message.chat.id || target.from?.is_bot || target.sender_chat) {
      await this.api.sendMessage(
        message.chat.id,
        'Для проверки нужно сообщение пользователя этой группы.',
      );
      return true;
    }
    if (target.date * 1000 < Date.now() - this.config.retentionDays * 86_400_000) {
      await this.api.sendMessage(message.chat.id, 'Сообщение старше срока хранения.');
      return true;
    }
    const id = this.store.capture(target);
    if (id === null) {
      await this.api.sendMessage(
        message.chat.id,
        'Нужен текст или подпись, совпадающие с сохранённой версией. Изменённое сообщение не размечается.',
      );
      return true;
    }
    const item = this.store.createCase(id);
    if (item.card_id !== null || item.status !== 'PENDING') {
      await this.api.sendMessage(
        message.chat.id,
        `Проверка уже существует: ${item.status}. ID: ${item.id}`,
      );
      return true;
    }
    const card = await this.api.sendMessage(
      message.chat.id,
      `Ручная разметка (30 минут).\nID: ${item.id}\n\n${item.raw_text.slice(0, 2800)}`,
      {
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Удалить / Spam', callback_data: `as:s:${item.id}` },
              { text: 'Оставить / Normal', callback_data: `as:n:${item.id}` },
              { text: 'Пропустить', callback_data: `as:k:${item.id}` },
            ],
          ],
        },
      },
    );
    this.store.bindCard(item.id, card.message_id);
    return true;
  }

  async callback(query: CallbackQuery): Promise<void> {
    const match = /^as:([snk]):([0-9a-f-]{36})$/.exec(query.data ?? '');
    if (!match) return;
    const id = match[2] ?? '';
    const card = query.message;
    const item = this.store.getCase(id);
    if (
      !card ||
      !item ||
      !this.config.chatIds.includes(item.chat_id) ||
      card.chat.id !== item.chat_id ||
      card.message_id !== item.card_id ||
      !(await this.isAdmin(item.chat_id, query.from.id))
    ) {
      await this.api.answerCallbackQuery(query.id, { text: 'Нет доступа к этой проверке.' });
      return;
    }
    const verdict: Verdict = match[1] === 's' ? 'spam' : match[1] === 'n' ? 'normal' : 'skip';
    if (verdict === 'spam') {
      // Fail closed when target identity or current membership cannot be checked.
      if (!item.user_id || item.sender_chat_id) {
        await this.api.answerCallbackQuery(query.id, {
          text: 'Нельзя удалить сообщение от имени канала.',
        });
        return;
      }
      try {
        const target = await this.api.getChatMember(item.chat_id, item.user_id);
        if (
          target.status === 'creator' ||
          target.status === 'administrator' ||
          target.user.is_bot
        ) {
          await this.api.answerCallbackQuery(query.id, {
            text: 'Администраторы и боты защищены от удаления.',
          });
          return;
        }
      } catch {
        await this.api.answerCallbackQuery(query.id, {
          text: 'Не удалось проверить автора. Повторите позже.',
        });
        return;
      }
    }
    if (!this.store.resolve(id, query.from.id, verdict)) {
      await this.api.answerCallbackQuery(query.id, {
        text: 'Решение уже принято или проверка истекла.',
      });
      return;
    }
    let deletion = '';
    if (verdict === 'spam' && item.telegram_message_id !== null) {
      try {
        await this.api.deleteMessage(item.chat_id, item.telegram_message_id);
        this.store.recordDeletion(id, true);
        deletion = ' Сообщение удалено.';
      } catch {
        this.store.recordDeletion(id, false);
        deletion = ' Удаление не удалось; разметка сохранена. Удалите сообщение вручную.';
      }
    }
    // A failed Telegram UI update must never roll back a committed human verdict.
    await this.api.answerCallbackQuery(query.id, { text: 'Решение сохранено.' }).catch(() => {});
    await this.api
      .editMessageText(
        item.chat_id,
        card.message_id,
        `Решение: ${verdict}.${deletion}\nОтмена разметки: /spam undo ${id}`,
        {
          reply_markup: { inline_keyboard: [] },
        },
      )
      .catch(() => {
        console.error('antispam_card_update_failed');
      });
  }

  close() {
    clearInterval(this.timer);
    this.store.close();
  }
}
