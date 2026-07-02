import { MAX_MUTE_MINUTES } from '../constants.ts';

const DURATION_RE =
  /(^|[^\p{L}\p{N}_])(\d{1,5})\s*(мин(?:\.|ут[а-я]*)?|м(?:\.|ин)?|ч(?:\.|ас(?:а|ов)?)?|час(?:а|ов)?|д(?:\.|н(?:я|ей|ень)?)?|день|дня|дней)?(?=$|[^\p{L}\p{N}_])/iu;

/** Parse "10", "2ч", "1 день" etc. into minutes, capped at the Telegram limit. */
export function extractDurationMinutes(text: string): number | null {
  const match = text.match(DURATION_RE);
  if (!match) {
    return null;
  }

  const value = Number(match[2]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const unit = (match[3] || 'мин').toLowerCase().replace(/\.$/u, '');

  return Math.min(value * unitMultiplier(unit), MAX_MUTE_MINUTES);
}

function unitMultiplier(unit: string): number {
  if (unit.startsWith('ч') || unit.startsWith('час')) {
    return 60;
  }

  if (unit.startsWith('д')) {
    return 1_440;
  }

  return 1;
}
