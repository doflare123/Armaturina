const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
const DEFAULT_TIMEOUT_MS = 12_000;
const TAG_CATALOG = [
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
  'праздник'
];
const TAG_ALIASES = new Map([
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
  ['celebration', 'праздник']
]);

class GeminiService {
  constructor(config = {}) {
    this.apiKey = config.apiKey || null;
    this.baseUrl = config.baseUrl || DEFAULT_GEMINI_BASE_URL;
    this.model = config.model || DEFAULT_GEMINI_MODEL;
    this.timeoutMs = Number(config.timeoutMs || DEFAULT_TIMEOUT_MS);
    this.telegramToken = config.telegramToken || null;
    this.maxTagsPerPack = Number(config.maxTagsPerPack || 0);
  }

  isEnabled() {
    return Boolean(this.apiKey);
  }

  async tagTelegramMedia(api, media) {
    if (!this.isEnabled()) {
      return createFallbackMetadata(media, 'gemini_disabled');
    }

    const analysisFileId = getAnalysisFileId(media);

    if (!analysisFileId) {
      return createFallbackMetadata(media, 'no_analysis_file');
    }

    const downloaded = await this.downloadTelegramFile(api, analysisFileId);

    if (!downloaded || !canSendInline(downloaded.mimeType)) {
      return createFallbackMetadata(media, `unsupported_${downloaded ? downloaded.mimeType : 'file'}`);
    }

    const prompt = [
      'Проанализируй мемный Telegram стикер или GIF thumbnail.',
      'Верни строго JSON без markdown.',
      `Выбери 3-7 тегов только из списка: ${TAG_CATALOG.join(', ')}.`,
      'Формат: {"tags":["тег"],"mood":"коротко","caption":"что происходит, до 80 символов"}.'
    ].join(' ');

    const data = await this.generateJson(
      [
        { text: prompt },
        {
          inline_data: {
            mime_type: downloaded.mimeType,
            data: downloaded.base64
          }
        }
      ],
      { mode: 'media' }
    );

    const metadata = normalizeMetadata({
      tags: data.tags,
      mood: data.mood,
      caption: data.caption,
      analysisFileId,
      analysisMimeType: downloaded.mimeType,
      taggedAt: new Date().toISOString()
    });

    if (metadata.tags.length === 0) {
      console.warn('Gemini returned no usable media tags:', {
        rawTags: data.tags,
        mood: data.mood,
        caption: data.caption,
        mimeType: downloaded.mimeType
      });

      return createFallbackMetadata(media, 'no_gemini_tags');
    }

    return metadata;
  }

  async selectTagsForContext(contextText) {
    if (!this.isEnabled() || !contextText || !contextText.trim()) {
      return [];
    }

    const prompt = [
      'Ты выбираешь теги для реакции-стикера в Telegram.',
      `Доступные теги: ${TAG_CATALOG.join(', ')}.`,
      'По сообщению выбери 2-5 тегов, которые лучше всего подходят для шуточного ответа.',
      'Верни строго JSON без markdown: {"wantedTags":["тег"]}.',
      `Сообщение: ${contextText.slice(0, 1000)}`
    ].join(' ');

    const data = await this.generateJson([{ text: prompt }], { mode: 'context' });

    const tags = normalizeTags(data.wantedTags || data.tags);

    if (tags.length === 0) {
      console.warn('Gemini returned no usable context tags:', {
        rawTags: data.wantedTags || data.tags,
        context: contextText.slice(0, 160)
      });
    }

    return tags;
  }

  async generateJson(parts, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        `${this.baseUrl}/models/${this.model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': this.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts
              }
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'object',
                required: options.mode === 'context' ? ['wantedTags'] : ['tags', 'mood', 'caption'],
                properties: {
                  tags: {
                    type: 'array',
                    items: { type: 'string' }
                  },
                  wantedTags: {
                    type: 'array',
                    items: { type: 'string' }
                  },
                  mood: { type: 'string' },
                  caption: { type: 'string' }
                }
              },
              temperature: 0.2,
              maxOutputTokens: 1024
            }
          }),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Gemini API returned ${response.status}: ${text.slice(0, 300)}`);
      }

      const geminiResponse = await response.json();
      const outputText = extractGeminiText(geminiResponse);

      if (!outputText) {
        console.warn('Gemini returned empty text:', summarizeGeminiResponse(geminiResponse));
        return {};
      }

      return parseJsonFromText(outputText, options.mode);
    } catch (error) {
      console.error(`Gemini request failed: ${error.message}`);
      return {};
    } finally {
      clearTimeout(timeout);
    }
  }

  async downloadTelegramFile(api, fileId) {
    if (!this.telegramToken) {
      return null;
    }

    const file = await api.getFile(fileId);

    if (!file.file_path) {
      return null;
    }

    const response = await fetch(`https://api.telegram.org/file/bot${this.telegramToken}/${file.file_path}`);

    if (!response.ok) {
      throw new Error(`Telegram file download failed: ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    return {
      base64: bytes.toString('base64'),
      mimeType: inferMimeType(file.file_path, response.headers.get('content-type')),
      filePath: file.file_path
    };
  }
}

function getAnalysisFileId(media) {
  return media.thumbnailFileId || media.fileId || null;
}

function canSendInline(mimeType) {
  return mimeType.startsWith('image/') || mimeType.startsWith('video/');
}

function inferMimeType(filePath, contentType) {
  const cleanContentType = String(contentType || '').split(';')[0].trim();

  if (cleanContentType && cleanContentType !== 'application/octet-stream') {
    return cleanContentType;
  }

  if (filePath.endsWith('.webp')) {
    return 'image/webp';
  }

  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
    return 'image/jpeg';
  }

  if (filePath.endsWith('.png')) {
    return 'image/png';
  }

  if (filePath.endsWith('.gif')) {
    return 'image/gif';
  }

  if (filePath.endsWith('.mp4')) {
    return 'video/mp4';
  }

  if (filePath.endsWith('.webm')) {
    return 'video/webm';
  }

  if (filePath.endsWith('.tgs')) {
    return 'application/x-tgsticker';
  }

  return 'application/octet-stream';
}

function extractGeminiText(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];

  return parts.map((part) => part.text || '').join('\n').trim();
}

function parseJsonFromText(text, mode = 'media') {
  const cleaned = String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const match = cleaned.match(/\{[\s\S]*\}/);

    if (match) {
      return JSON.parse(match[0]);
    }

    console.warn('Gemini returned non-JSON text:', cleaned.slice(0, 500));
    return tagsFromFreeText(cleaned, mode);
  }
}

function tagsFromFreeText(text, mode) {
  const lowerText = String(text || '').toLowerCase();
  const tags = [];

  for (const tag of TAG_CATALOG) {
    if (lowerText.includes(tag)) {
      tags.push(tag);
    }
  }

  for (const [alias, tag] of TAG_ALIASES.entries()) {
    if (lowerText.includes(alias)) {
      tags.push(tag);
    }
  }

  const normalized = normalizeTags(tags);

  if (normalized.length === 0) {
    return {};
  }

  return mode === 'context'
    ? { wantedTags: normalized }
    : {
        tags: normalized,
        mood: 'free_text_fallback',
        caption: lowerText.slice(0, 80)
      };
}

function summarizeGeminiResponse(data) {
  const candidate = data.candidates?.[0] || {};

  return {
    finishReason: candidate.finishReason,
    safetyRatings: candidate.safetyRatings,
    promptFeedback: data.promptFeedback
  };
}

function createFallbackMetadata(media, reason) {
  return normalizeMetadata({
    tags: media.kind === 'animation' ? ['мем'] : ['мем', 'стикер'].filter(Boolean),
    mood: reason,
    caption: null,
    analysisFileId: getAnalysisFileId(media),
    analysisMimeType: null,
    taggedAt: null
  });
}

function normalizeMetadata(metadata = {}) {
  return {
    tags: normalizeTags(metadata.tags),
    mood: metadata.mood || null,
    caption: metadata.caption || null,
    analysisFileId: metadata.analysisFileId || null,
    analysisMimeType: metadata.analysisMimeType || null,
    taggedAt: metadata.taggedAt || null
  };
}

function normalizeTags(tags = []) {
  const normalized = [];

  for (const rawTag of Array.isArray(tags) ? tags : []) {
    const tag = normalizeTag(rawTag);

    if (tag && !normalized.includes(tag)) {
      normalized.push(tag);
    }
  }

  return normalized.slice(0, 8);
}

function normalizeTag(rawTag) {
  const tag = String(rawTag || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '');

  if (!tag) {
    return null;
  }

  if (TAG_CATALOG.includes(tag)) {
    return tag;
  }

  if (TAG_ALIASES.has(tag)) {
    return TAG_ALIASES.get(tag);
  }

  // Keep unknown model-proposed tags too. They can still match if context analysis
  // produces the same tag later, and this avoids silently throwing useful labels away.
  return tag.slice(0, 32);
}

export {
  GeminiService
};
