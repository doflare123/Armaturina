import type { Api } from 'grammy';
import type { ModerationTarget } from '../types.ts';
import type { BotDeps } from './deps.ts';

/** Whether the bot itself may restrict/ban members in this chat. */
export async function canBotModerate(deps: BotDeps, chatId: number): Promise<boolean> {
  try {
    const botInfo = await deps.getBotInfo();
    const member = await deps.api.getChatMember(chatId, botInfo.id);

    if (member.status === 'creator') {
      return true;
    }

    return member.status === 'administrator' && Boolean(member.can_restrict_members);
  } catch (error) {
    console.error('Failed to check bot moderation permissions:', error);
    return false;
  }
}

/** Whether a ban can also fulfil its promise to remove the member's messages. */
export async function canBotBanAndDelete(deps: BotDeps, chatId: number): Promise<boolean> {
  try {
    const botInfo = await deps.getBotInfo();
    const member = await deps.api.getChatMember(chatId, botInfo.id);

    if (member.status === 'creator') {
      return true;
    }

    return (
      member.status === 'administrator' &&
      Boolean(member.can_restrict_members) &&
      Boolean(member.can_delete_messages)
    );
  } catch (error) {
    console.error('Failed to check bot ban/delete permissions:', error);
    return false;
  }
}

/**
 * Whether `target` may be moderated. Admins/owners can't be, so this also warns
 * the chat and returns `false` for them. Errors default to allowing the attempt.
 */
export async function canModerateTarget(
  deps: BotDeps,
  chatId: number,
  target: ModerationTarget,
  actionName: string,
): Promise<boolean> {
  try {
    const member = await deps.api.getChatMember(chatId, target.userId);

    if (member.status === 'creator' || member.status === 'administrator') {
      await sendTargetAdminError(deps.api, chatId, target, actionName);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Failed to check moderation target:', error);
    return true;
  }
}

export async function sendTargetAdminError(
  api: Api,
  chatId: number,
  target: ModerationTarget,
  actionName: string,
): Promise<void> {
  await api.sendMessage(
    chatId,
    `Не могу ${actionName} ${target.label}: Telegram не дает боту трогать админов и владельца чата. Сначала сними с него админку, потом зовите Арматурину с арматурой.`,
  );
}

export function isChatAdminRequiredError(error: unknown): boolean {
  return telegramErrorText(error).includes('CHAT_ADMIN_REQUIRED');
}

export function isTargetAdminError(error: unknown): boolean {
  const text = telegramErrorText(error).toLowerCase();

  return (
    text.includes('user is an administrator of the chat') ||
    text.includes('user_admin_invalid') ||
    text.includes('not enough rights to restrict') ||
    text.includes('not enough rights to ban') ||
    text.includes("can't restrict") ||
    text.includes("can't ban")
  );
}

function telegramErrorText(error: unknown): string {
  const details = error as { description?: unknown; message?: unknown } | null;
  return String(details?.description || details?.message || '');
}
