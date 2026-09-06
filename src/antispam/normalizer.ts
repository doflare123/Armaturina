import { createHash } from 'node:crypto';

/** Version this contract before changing it: hashes define training duplicate groups. */
export function normalizeMessage(rawText: string) {
  const normalizedText = rawText
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)[^\s<>]+/giu, '<URL>')
    .replace(/(?<![\p{L}\p{N}_])@[a-z0-9_]{1,32}\b/giu, '<USERNAME>')
    .replace(/\d{7,}/gu, '<NUMBER>')
    .replace(/\s+/gu, ' ')
    .trim();
  return {
    rawText,
    normalizedText,
    reducedText: normalizedText.replace(/(.)\1{2,}/gu, '$1$1'),
    textHash: createHash('sha256').update(normalizedText).digest('hex'),
    normalizerVersion: 1,
  };
}
