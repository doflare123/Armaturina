export interface Entity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}
export const NUMERIC_FEATURES = [
  'message_length',
  'word_count',
  'unique_word_ratio',
  'uppercase_ratio',
  'digit_ratio',
  'special_char_ratio',
  'emoji_count',
  'emoji_ratio',
  'url_count',
  'telegram_url_count',
  'external_url_count',
  'username_mention_count',
  'has_phone_like_number',
  'newline_count',
  'repeated_character_score',
] as const;

export function wordCounts(text: string): Map<string, number> {
  const words = text.toLowerCase().match(/<url>|<username>|<number>|[\p{L}\p{N}_]+/gu) ?? [];
  const counts = new Map<string, number>();
  words.forEach((word, i) => {
    counts.set(word, (counts.get(word) ?? 0) + 1);
    if (i) {
      const pair = `${words[i - 1]} ${word}`;
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
  });
  return counts;
}

/** Raw text statistics; entity offsets use Telegram's UTF-16 units. */
export function numericFeatures(raw: string, entities: readonly Entity[] = []): number[] {
  const chars = Array.from(raw),
    length = chars.length;
  const ratio = (n: number) => (length ? n / length : 0);
  const words = raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const links: Array<{ offset: number; length: number; url: string }> = [];
  for (const m of raw.matchAll(/(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)[^\s<>]+/giu)) {
    links.push({ offset: m.index, length: m[0].length, url: m[0] });
  }
  const mentions = new Set(
    [...raw.matchAll(/(?<![\p{L}\p{N}_])@[a-z0-9_]{1,32}\b/giu)].map((m) => m.index),
  );
  for (const e of entities) {
    if (
      !Number.isInteger(e.offset) ||
      !Number.isInteger(e.length) ||
      e.offset < 0 ||
      e.length <= 0 ||
      e.offset + e.length > raw.length
    )
      continue;
    if (e.type === 'mention' || e.type === 'text_mention') mentions.add(e.offset);
    if (e.type === 'url' || e.type === 'text_link') {
      const url = e.type === 'text_link' ? e.url : raw.slice(e.offset, e.offset + e.length);
      if (typeof url !== 'string') continue;
      const existing = links.findIndex((l) => l.offset === e.offset);
      const link = { offset: e.offset, length: e.length, url };
      if (existing >= 0) links[existing] = link;
      else links.push(link);
    }
  }
  const telegram = links.filter(({ url }) => {
    try {
      const host = new URL(
        /^https?:\/\//i.test(url) ? url : `https://${url}`,
      ).hostname.toLowerCase();
      return ['t.me', 'telegram.me', 'telegram.dog'].includes(host);
    } catch {
      return false;
    }
  }).length;
  const emoji = chars.filter((c) =>
    /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(c),
  ).length;
  let repeated = 0;
  for (let i = 0; i < chars.length; ) {
    let j = i + 1;
    while (j < chars.length && chars[j] === chars[i]) j++;
    if (j - i >= 3) repeated += j - i;
    i = j;
  }
  return [
    length,
    words.length,
    words.length ? new Set(words).size / words.length : 0,
    ratio(chars.filter((c) => /\p{Lu}/u.test(c)).length),
    ratio(chars.filter((c) => /\p{N}/u.test(c)).length),
    ratio(chars.filter((c) => /[^\p{L}\p{N}\s]/u.test(c)).length),
    emoji,
    ratio(emoji),
    links.length,
    telegram,
    links.length - telegram,
    mentions.size,
    /(?:\+?\d[\s().-]*){7,15}/u.test(raw) ? 1 : 0,
    (raw.match(/\n/g) ?? []).length,
    ratio(repeated),
  ];
}

/** Fixed bounded transforms require no validation-set fitting. */
export function scaledNumeric(raw: string, entities: readonly Entity[] = []): number[] {
  const caps: Record<number, number> = {
    0: 16384,
    1: 4096,
    6: 256,
    8: 32,
    9: 32,
    10: 32,
    11: 32,
    13: 256,
  };
  return numericFeatures(raw, entities).map((v, i) =>
    caps[i] ? Math.min(1, Math.log1p(v) / Math.log1p(caps[i])) : Math.min(1, Math.max(0, v)),
  );
}
