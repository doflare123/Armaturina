import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBot } from './bot.js';
import { loadConfig } from './config.js';

export async function armaturina(options = {}) {
  // Entry point stays tiny: config validation and bot startup live in separate modules.
  const config = loadConfig(options);
  const bot = createBot(config);

  await bot.start();
  return bot;
}

async function main() {
  await armaturina();
}

const currentFilePath = fileURLToPath(import.meta.url);
const startedDirectly = process.argv[1] && currentFilePath === path.resolve(process.argv[1]);

if (startedDirectly) {
  main().catch((error) => {
  console.error('Armaturina failed to start:', error);
  process.exitCode = 1;
  });
}
