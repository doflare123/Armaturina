import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Armaturina, createBot } from './bot/createBot.ts';
import { type ConfigOptions, loadConfig } from './config.ts';

export type { Armaturina } from './bot/createBot.ts';
export type { ConfigOptions } from './config.ts';

/** Load config, build the bot and start polling in the background. */
export async function armaturina(options: ConfigOptions = {}): Promise<Armaturina> {
  const config = loadConfig(options);
  const bot = createBot(config);

  await bot.start();
  return bot;
}

async function main(): Promise<void> {
  const bot = await armaturina();

  const shutdown = async (): Promise<void> => {
    await bot.stop();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const currentFilePath = fileURLToPath(import.meta.url);
const startedDirectly =
  process.argv[1] !== undefined && currentFilePath === path.resolve(process.argv[1]);

if (startedDirectly) {
  main().catch((error) => {
    console.error('Armaturina failed to start:', error);
    process.exitCode = 1;
  });
}
