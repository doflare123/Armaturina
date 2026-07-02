import type { Pool } from '../types.ts';

/** Matches a leading "Арматурина"/"Арматрина" invocation, tolerating punctuation. */
const ARMATURINA_RE =
  /^(?:[\s,.:;!?\-–—"'«»()]*)(?:арматур[\p{L}\p{N}_]*|арматр[\p{L}\p{N}_]*)(?![\p{L}\p{N}_])/iu;
const LEADING_PUNCT_RE = /^[\s,.:;!?\-–—"'«»()]+/u;

export const USERNAME_RE = /@([a-zA-Z0-9_]{5,32})/;
export const LEF_VARIANT_RE = /^(?:оформи|сделай)\s+(горловой|слюнявый|минет)/iu;

/**
 * The text after the "Арматурина" trigger, cleaned of leading punctuation,
 * or `null` when the message does not invoke the bot by name.
 */
export function getTriggerTail(text: string): string | null {
  const match = text.match(ARMATURINA_RE);
  if (!match) {
    return null;
  }

  return text.slice(match[0].length).replace(LEADING_PUNCT_RE, '').trim();
}

export function isFasTail(tail: string): boolean {
  return /^фас[.!?]*$/iu.test(tail.trim());
}

export function isMuteTail(tail: string): boolean {
  return /^завари\s+ебало(?=$|[^\p{L}\p{N}_])/iu.test(tail.trim());
}

export function isBanTail(tail: string): boolean {
  return /^уеби(?=$|[^\p{L}\p{N}_])/iu.test(tail.trim());
}

export function isLefTail(tail: string): boolean {
  return /^(оформи|сделай)\s+(горловой|слюнявый|минет)(?=$|[^\p{L}\p{N}_])/iu.test(tail.trim());
}

export function startsWithLefVerb(tail: string): boolean {
  return /^(оформи|сделай)(?=$|[^\p{L}\p{N}_])/iu.test(tail.trim());
}

export function isAddGifText(lowerText: string): boolean {
  return lowerText.includes('добав') && (lowerText.includes('гиф') || lowerText.includes('gif'));
}

export function isAddStickerPackText(lowerText: string): boolean {
  return (
    lowerText.includes('добав') &&
    (lowerText.includes('стикерпак') ||
      lowerText.includes('стикер пак') ||
      lowerText.includes('пак'))
  );
}

export function getRequestedPool(lowerText: string): Pool {
  return lowerText.includes('ультра') || lowerText.includes('ultra') ? 'ultra' : 'regular';
}

/** Whether a trigger tail is a shape the bot acts on (vs. incidental chatter). */
export function isAllowedTriggerTail(lowerTail: string): boolean {
  if (!lowerTail) {
    return true;
  }

  return (
    isAddGifText(lowerTail) ||
    isAddStickerPackText(lowerTail) ||
    isMuteTail(lowerTail) ||
    isBanTail(lowerTail) ||
    isLefTail(lowerTail) ||
    USERNAME_RE.test(lowerTail) ||
    isFasTail(lowerTail)
  );
}

/** Best-effort Telegram sticker-set name from free text (latin identifier, last wins). */
export function extractStickerPackName(text: string): string | null {
  const candidates = text
    .replace(/[,\n\r]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => /^[a-zA-Z0-9_]{2,64}$/.test(word));

  return candidates[candidates.length - 1] ?? null;
}
