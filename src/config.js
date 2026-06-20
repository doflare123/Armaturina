import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDataFilePath = path.resolve(currentDir, '..', 'data', 'media-pool.json');

function loadConfig(options = {}) {
  const token = options.token || process.env.ARMATURINA_BOT_TOKEN || process.env.BOT_TOKEN;
  const dataFilePath = options.dataFilePath ||
    process.env.ARMATURINA_DATA_FILE ||
    process.env.DATA_FILE ||
    defaultDataFilePath;
  const geminiMaxTagsPerPack = Number(
    options.geminiMaxTagsPerPack ||
    process.env.ARMATURINA_GEMINI_MAX_TAGS_PER_PACK ||
    30
  );

  if (!token) {
    throw new Error('BOT_TOKEN is required. Copy .env.example to .env and set the token.');
  }

  return {
    token,
    dataFilePath: path.isAbsolute(dataFilePath)
      ? dataFilePath
      : path.resolve(process.cwd(), dataFilePath),
    gemini: {
      apiKey: options.geminiApiKey || process.env.ARMATURINA_GEMINI_API_KEY || process.env.GEMINI_API_KEY || null,
      baseUrl: options.geminiBaseUrl || process.env.ARMATURINA_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
      model: options.geminiModel || process.env.ARMATURINA_GEMINI_MODEL || 'gemini-3.5-flash',
      timeoutMs: Number(options.geminiTimeoutMs || process.env.ARMATURINA_GEMINI_TIMEOUT_MS || 12_000),
      maxTagsPerPack: Number.isFinite(geminiMaxTagsPerPack) ? Math.max(0, geminiMaxTagsPerPack) : 30
    }
  };
}

export {
  loadConfig
};
