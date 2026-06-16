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

  if (!token) {
    throw new Error('BOT_TOKEN is required. Copy .env.example to .env and set the token.');
  }

  return {
    token,
    dataFilePath: path.isAbsolute(dataFilePath)
      ? dataFilePath
      : path.resolve(process.cwd(), dataFilePath)
  };
}

export {
  loadConfig
};
