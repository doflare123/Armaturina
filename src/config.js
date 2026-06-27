import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDataFilePath = path.resolve(currentDir, '..', 'data', 'media-pool.json');
const defaultLefAssetsPath = path.resolve(currentDir, '..', 'data', 'lef');

function loadConfig(options = {}) {
  const token = options.token || process.env.ARMATURINA_BOT_TOKEN || process.env.BOT_TOKEN;
  const dataFilePath = options.dataFilePath ||
    process.env.ARMATURINA_DATA_FILE ||
    process.env.DATA_FILE ||
    defaultDataFilePath;
  const lefAssetsPath = options.lefAssetsPath ||
    process.env.ARMATURINA_LEF_ASSETS ||
    defaultLefAssetsPath;
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
    lefAssetsPath: path.isAbsolute(lefAssetsPath)
      ? lefAssetsPath
      : path.resolve(process.cwd(), lefAssetsPath),
    gemini: {
      apiKey: options.geminiApiKey || process.env.ARMATURINA_GEMINI_API_KEY || process.env.GEMINI_API_KEY || null,
      baseUrl: options.geminiBaseUrl || process.env.ARMATURINA_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
      model: options.geminiModel || process.env.ARMATURINA_GEMINI_MODEL || 'gemini-3.5-flash',
      timeoutMs: Number(options.geminiTimeoutMs || process.env.ARMATURINA_GEMINI_TIMEOUT_MS || 12_000),
      maxTagsPerPack: Number.isFinite(geminiMaxTagsPerPack) ? Math.max(0, geminiMaxTagsPerPack) : 30,
      debug: parseBoolean(options.geminiDebug ?? process.env.ARMATURINA_GEMINI_DEBUG)
    }
  };
}

function parseBoolean(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

export {
  loadConfig
};
