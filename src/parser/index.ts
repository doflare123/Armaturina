import type { Message } from 'grammy/types';
import type { Action, RetagScope } from '../types.ts';
import { parseBanAction, parseLefAction, parseMuteAction } from './actions.ts';
import {
  extractStickerPackName,
  getRequestedPool,
  getTriggerTail,
  isAddGifText,
  isAddStickerPackText,
  isAllowedTriggerTail,
  startsWithLefVerb,
} from './patterns.ts';
import { extractMentionTarget, extractReplyTarget, getMessageText } from './targets.ts';

export { getMessageText } from './targets.ts';

/** Classify a message into exactly one {@link Action}. */
export function parseAction(message: Message): Action {
  const text = getMessageText(message).trim();

  const command = parseCommand(message, text);
  if (command) {
    return command;
  }

  const triggerTail = getTriggerTail(text);
  if (triggerTail === null) {
    return { type: 'none' };
  }

  return parsePhrase(message, text, triggerTail);
}

/** Slash-command branch. Returns `null` when `text` is not a known command. */
function parseCommand(message: Message, text: string): Action | null {
  const lower = text.toLowerCase();

  if (lower.startsWith('/arm_help') || lower.startsWith('/help')) return { type: 'help' };
  if (lower.startsWith('/pool')) return { type: 'pool' };
  if (lower.startsWith('/stats')) return { type: 'stats' };
  if (lower.startsWith('/top')) return { type: 'top' };
  if (lower.startsWith('/lef_top') || lower.startsWith('/snake_top')) return { type: 'lef_top' };
  if (lower.startsWith('/mute')) return parseMuteAction(message, text);
  if (lower.startsWith('/ban')) return parseBanAction(message, text);
  if (lower.startsWith('/addultragif')) return { type: 'add_gif', pool: 'ultra' };
  if (lower.startsWith('/retag')) return parseRetag(text);
  if (lower.startsWith('/addultrastickerpack')) {
    return { type: 'add_sticker_pack', packName: firstArg(text), pool: 'ultra' };
  }
  if (lower.startsWith('/addgif')) return { type: 'add_gif', pool: 'regular' };
  if (lower.startsWith('/addstickerpack')) {
    return { type: 'add_sticker_pack', packName: firstArg(text), pool: 'regular' };
  }

  return null;
}

/** "Арматурина …" phrase branch, operating on the trigger tail. */
function parsePhrase(message: Message, text: string, triggerTail: string): Action {
  const lowerTail = triggerTail.toLowerCase();

  const mute = parseMuteAction(message, triggerTail, text);
  if (mute.type !== 'none') return mute;

  const ban = parseBanAction(message, triggerTail, text);
  if (ban.type !== 'none') return ban;

  const lef = parseLefAction(message, triggerTail, text);
  if (lef.type !== 'none') return lef;

  // A lef verb without a valid variant is deliberately swallowed, never a hit.
  if (startsWithLefVerb(lowerTail)) return { type: 'none' };
  if (!isAllowedTriggerTail(lowerTail)) return { type: 'none' };

  if (isAddGifText(lowerTail)) {
    return { type: 'add_gif', pool: getRequestedPool(lowerTail) };
  }

  if (isAddStickerPackText(lowerTail)) {
    return {
      type: 'add_sticker_pack',
      packName: extractStickerPackName(triggerTail),
      pool: getRequestedPool(lowerTail),
    };
  }

  const target = extractMentionTarget(message, text, triggerTail) ?? extractReplyTarget(message);

  return target ? { type: 'hit', target } : { type: 'none' };
}

function parseRetag(text: string): Action {
  const parts = text.split(/\s+/);
  const poolArg = parts[1];
  const pool: RetagScope =
    poolArg === 'regular' || poolArg === 'ultra' || poolArg === 'all' ? poolArg : 'all';
  const rawLimit = Number(parts[2] || (pool === 'all' ? parts[1] : 25));
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 25;

  return { type: 'retag', pool, limit };
}

function firstArg(text: string): string | null {
  return text.split(/\s+/)[1] || null;
}
