import type { Message } from 'grammy/types';
import type { Action, LefVariant } from '../types.ts';
import { extractDurationMinutes } from './duration.ts';
import { isBanTail, isLefTail, isMuteTail, LEF_VARIANT_RE } from './patterns.ts';
import { buildSelfTarget, extractMentionTarget, extractReplyTarget } from './targets.ts';

/**
 * Mute, ban and lef are reachable both as slash commands and as "Арматурина …"
 * phrases, so each builder takes the fragment to inspect (`commandText`) plus
 * the full message text used only to locate a mention entity.
 */

export function parseMuteAction(
  message: Message,
  commandText: string,
  fullText: string = commandText,
): Action {
  const lower = commandText.toLowerCase();
  if (!lower.startsWith('/mute') && !isMuteTail(lower)) {
    return { type: 'none' };
  }

  return {
    type: 'mute',
    target: extractMentionTarget(message, fullText, commandText) ?? extractReplyTarget(message),
    minutes: extractDurationMinutes(commandText),
  };
}

export function parseBanAction(
  message: Message,
  commandText: string,
  fullText: string = commandText,
): Action {
  const lower = commandText.toLowerCase();
  if (!lower.startsWith('/ban') && !isBanTail(lower)) {
    return { type: 'none' };
  }

  return {
    type: 'ban',
    target: extractMentionTarget(message, fullText, commandText) ?? extractReplyTarget(message),
  };
}

export function parseLefAction(
  message: Message,
  commandText: string,
  fullText: string = commandText,
): Action {
  const lower = commandText.toLowerCase();
  if (!isLefTail(lower)) {
    return { type: 'none' };
  }

  const variant = lower.match(LEF_VARIANT_RE)?.[1] as LefVariant | undefined;

  return {
    type: 'lef',
    target: extractMentionTarget(message, fullText, commandText) ?? buildSelfTarget(message),
    variant: variant ?? 'горловой',
  };
}
