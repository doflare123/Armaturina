/**
 * The controlled tag vocabulary shared by the Gemini tagger and the media store.
 * Both sides normalise through the same functions so a tag written on ingest
 * always matches a tag requested at hit time.
 */

export const TAG_CATALOG = [
  'кринж',
  'осуждение',
  'злость',
  'радость',
  'шок',
  'грусть',
  'усталость',
  'победа',
  'провал',
  'фейспалм',
  'сарказм',
  'хаос',
  'абсурд',
  'угроза_шутка',
  'танец',
  'падение',
  'мем',
  'человек',
  'животное',
  'поддержка',
  'тупняк',
  'праздник',
] as const;

export const TAG_ALIASES = new Map<string, string>([
  ['cringe', 'кринж'],
  ['awkward', 'кринж'],
  ['judgement', 'осуждение'],
  ['judgment', 'осуждение'],
  ['disapproval', 'осуждение'],
  ['angry', 'злость'],
  ['anger', 'злость'],
  ['rage', 'злость'],
  ['happy', 'радость'],
  ['joy', 'радость'],
  ['shock', 'шок'],
  ['surprise', 'шок'],
  ['sad', 'грусть'],
  ['sadness', 'грусть'],
  ['tired', 'усталость'],
  ['fatigue', 'усталость'],
  ['win', 'победа'],
  ['victory', 'победа'],
  ['fail', 'провал'],
  ['failure', 'провал'],
  ['facepalm', 'фейспалм'],
  ['sarcasm', 'сарказм'],
  ['chaos', 'хаос'],
  ['absurd', 'абсурд'],
  ['threat', 'угроза_шутка'],
  ['dance', 'танец'],
  ['fall', 'падение'],
  ['meme', 'мем'],
  ['human', 'человек'],
  ['person', 'человек'],
  ['animal', 'животное'],
  ['support', 'поддержка'],
  ['stupid', 'тупняк'],
  ['confusion', 'тупняк'],
  ['party', 'праздник'],
  ['celebration', 'праздник'],
]);

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 32;
const CATALOG = new Set<string>(TAG_CATALOG);

/** Canonicalise a single raw tag, mapping aliases onto the catalog. */
export function normalizeTag(rawTag: unknown): string | null {
  const tag = String(rawTag ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '');

  if (!tag) {
    return null;
  }

  if (CATALOG.has(tag)) {
    return tag;
  }

  const alias = TAG_ALIASES.get(tag);
  if (alias) {
    return alias;
  }

  // Keep unknown model-proposed tags: they can still match if context analysis
  // later produces the same label, so we avoid throwing useful signal away.
  return tag.slice(0, MAX_TAG_LENGTH);
}

/** Canonicalise and de-duplicate a list of tags, capped at {@link MAX_TAGS}. */
export function normalizeTags(tags: unknown): string[] {
  const normalized: string[] = [];

  for (const rawTag of Array.isArray(tags) ? tags : []) {
    const tag = normalizeTag(rawTag);

    if (tag && !normalized.includes(tag)) {
      normalized.push(tag);
    }
  }

  return normalized.slice(0, MAX_TAGS);
}

/** How many of the wanted tags are present on the actual media. */
export function countTagMatches(actualTags: unknown, wantedTags: unknown): number {
  const actual = new Set(normalizeTags(actualTags));

  return normalizeTags(wantedTags).filter((tag) => actual.has(tag)).length;
}
