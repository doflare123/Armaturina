import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpamConfig } from './antispam/config.ts';
import type { Config } from './types.ts';

export interface ConfigOptions {
  token?: string;
  dataFilePath?: string;
  lefAssetsPath?: string;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  geminiModel?: string;
  geminiTimeoutMs?: number | string;
  geminiMaxTagsPerPack?: number | string;
  geminiDebug?: boolean | string;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDataFilePath = path.resolve(currentDir, '..', 'data', 'media-pool.json');
const defaultLefAssetsPath = path.resolve(currentDir, '..', 'data', 'lef');

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
const DEFAULT_GEMINI_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_TAGS_PER_PACK = 30;

export function loadConfig(options: ConfigOptions = {}): Config {
  const token = options.token || process.env.ARMATURINA_BOT_TOKEN || process.env.BOT_TOKEN;

  if (!token) {
    throw new Error('BOT_TOKEN is required. Copy .env.example to .env and set the token.');
  }

  const dataFilePath =
    options.dataFilePath ||
    process.env.ARMATURINA_DATA_FILE ||
    process.env.DATA_FILE ||
    defaultDataFilePath;
  const lefAssetsPath =
    options.lefAssetsPath || process.env.ARMATURINA_LEF_ASSETS || defaultLefAssetsPath;
  const maxTags = Number(
    options.geminiMaxTagsPerPack ||
      process.env.ARMATURINA_GEMINI_MAX_TAGS_PER_PACK ||
      DEFAULT_MAX_TAGS_PER_PACK,
  );

  return {
    antispam: loadSpamConfig(),
    token,
    dataFilePath: toAbsolute(dataFilePath),
    lefAssetsPath: toAbsolute(lefAssetsPath),
    gemini: {
      apiKey:
        options.geminiApiKey ||
        process.env.ARMATURINA_GEMINI_API_KEY ||
        process.env.GEMINI_API_KEY ||
        null,
      baseUrl:
        options.geminiBaseUrl || process.env.ARMATURINA_GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL,
      model: options.geminiModel || process.env.ARMATURINA_GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      timeoutMs: Number(
        options.geminiTimeoutMs ||
          process.env.ARMATURINA_GEMINI_TIMEOUT_MS ||
          DEFAULT_GEMINI_TIMEOUT_MS,
      ),
      maxTagsPerPack: Number.isFinite(maxTags) ? Math.max(0, maxTags) : DEFAULT_MAX_TAGS_PER_PACK,
      debug: parseBoolean(options.geminiDebug ?? process.env.ARMATURINA_GEMINI_DEBUG),
    },
  };
}

function toAbsolute(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function parseBoolean(value: unknown): boolean {
  return value === true || String(value).toLowerCase() === 'true';
}
