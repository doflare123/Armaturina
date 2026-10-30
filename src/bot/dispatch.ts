import type { Message } from 'grammy/types';
import { NON_ADMIN_BAN_REPLIES, NON_ADMIN_HIT_REPLIES } from '../messages.ts';
import { parseAction } from '../parser/index.ts';
import { isGroupChat } from '../services/admin.ts';
import type { Action, Target } from '../types.ts';
import { withModerationPriority } from './apiQueue.ts';
import type { BotDeps } from './deps.ts';
import { handleHit } from './handlers/hit.ts';
import {
  handlePrivateMessage,
  sendHelp,
  sendLefTop,
  sendPoolStats,
  sendStats,
  sendTop,
} from './handlers/info.ts';
import { handleLef } from './handlers/lef.ts';
import { handleAddGif, handleAddStickerPack, handleRetag } from './handlers/media.ts';
import { handleBan, handleMute, handleUnauthorizedMute } from './handlers/moderation.ts';
import { sendRandomReply } from './replies.ts';

type PublicAction = Extract<Action, { type: 'stats' | 'top' | 'lef_top' | 'lef' }>;

/** Entry point for every group/private message update. */
export async function handleMessage(deps: BotDeps, message: Message): Promise<void> {
  if (!isGroupChat(message.chat)) {
    await handlePrivateMessage(deps, message);
    return;
  }

  const action = parseAction(message);

  if (deps.commands && (action.type === 'lef' || action.type === 'hit')) {
    // Resolve before remembering this command or accepting newer messages.
    const target = snapshotTarget(deps, message.chat.id, action.target, action.type === 'hit');
    const queued: Action =
      action.type === 'hit'
        ? { ...action, target: target ?? action.target }
        : { ...action, target };
    deps.commands.enqueue(message.chat.id, () => handleAction(deps, message, queued));
    deps.store.rememberMessage(message);
    return;
  }

  await handleAction(deps, message, action);
  deps.store.rememberMessage(message);
}

function snapshotTarget(
  deps: BotDeps,
  chatId: number,
  target: Target | null,
  requireMessage: boolean,
): Target | null {
  if (!target || target.messageId) return target;
  const last = deps.store.getLastMessage(chatId, target);
  return {
    ...target,
    messageId: last?.messageId ?? null,
    userId: requireMessage && !last ? null : (target.userId ?? last?.userId ?? null),
    username: last?.username ?? null,
    text: last?.text ?? '',
  };
}

async function handleAction(deps: BotDeps, message: Message, action: Action): Promise<void> {
  if (isPublicAction(action)) {
    await handlePublicAction(deps, message, action);
    return;
  }

  if (action.type !== 'none') {
    if (action.type === 'mute' || action.type === 'ban') {
      await withModerationPriority(() => handleAdminAction(deps, message, action));
    } else {
      await handleAdminAction(deps, message, action);
    }
  }
}

function isPublicAction(action: Action): action is PublicAction {
  return (
    action.type === 'stats' ||
    action.type === 'top' ||
    action.type === 'lef_top' ||
    action.type === 'lef'
  );
}

async function handlePublicAction(
  deps: BotDeps,
  message: Message,
  action: PublicAction,
): Promise<void> {
  switch (action.type) {
    case 'stats':
      return sendStats(deps, message.chat.id);
    case 'top':
      return sendTop(deps, message.chat.id);
    case 'lef_top':
      return sendLefTop(deps, message.chat.id);
    case 'lef':
      return handleLef(deps, message, action);
  }
}

async function handleAdminAction(deps: BotDeps, message: Message, action: Action): Promise<void> {
  if (!(await canUseAdminAction(deps, message))) {
    await handleUnauthorizedAdminAction(deps, message, action);
    return;
  }

  switch (action.type) {
    case 'help':
      return sendHelp(deps, message.chat.id);
    case 'pool':
      return sendPoolStats(deps, message.chat.id);
    case 'add_sticker_pack':
      return handleAddStickerPack(deps, message, action.packName, action.pool);
    case 'add_gif':
      return handleAddGif(deps, message, action.pool);
    case 'retag':
      return handleRetag(deps, message, action.pool, action.limit);
    case 'mute':
      return handleMute(deps, message, action);
    case 'ban':
      return handleBan(deps, message, action);
    case 'hit':
      return handleHit(deps, message, action.target);
  }
}

async function handleUnauthorizedAdminAction(
  deps: BotDeps,
  message: Message,
  action: Action,
): Promise<void> {
  switch (action.type) {
    case 'hit':
      return sendRandomReply(deps.api, message, NON_ADMIN_HIT_REPLIES);
    case 'ban':
      return sendRandomReply(deps.api, message, NON_ADMIN_BAN_REPLIES);
    case 'mute':
      return handleUnauthorizedMute(deps, message);
  }
}

async function canUseAdminAction(deps: BotDeps, message: Message): Promise<boolean> {
  try {
    return await deps.admins.isChatAdmin(message);
  } catch (error) {
    console.error('Failed to check chat administrators:', error);
    await deps.api.sendMessage(
      message.chat.id,
      'Не могу проверить права админа. Дай боту права администратора в группе, иначе Telegram не отдает список админов.',
    );
    return false;
  }
}
