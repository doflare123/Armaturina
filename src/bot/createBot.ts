import { type RunnerHandle, run, sequentialize } from '@grammyjs/runner';
import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { AdminChecker } from '../services/admin.ts';
import { GeminiService } from '../services/gemini.ts';
import { FileStore } from '../store/fileStore.ts';
import type { Config } from '../types.ts';
import type { BotDeps } from './deps.ts';
import { handleMessage } from './dispatch.ts';

export interface Armaturina {
  start(): Promise<void>;
  stop(): Promise<void>;
  bot: Bot;
  store: FileStore;
  readonly pollingPromise: Promise<void> | null;
}

/** Wire up the bot, store, admin cache and Gemini into a startable instance. */
export function createBot(config: Config): Armaturina {
  const bot = new Bot(config.token);
  const store = new FileStore(config.dataFilePath);
  const admins = new AdminChecker(bot.api);
  const gemini = new GeminiService({ ...config.gemini, telegramToken: config.token });

  let botInfo: UserFromGetMe | null = null;
  let started = false;
  let runner: RunnerHandle | null = null;

  const deps: BotDeps = {
    api: bot.api,
    config,
    store,
    gemini,
    admins,
    async getBotInfo() {
      botInfo ??= await bot.api.getMe();
      return botInfo;
    },
  };

  async function start(): Promise<void> {
    if (started) {
      return;
    }

    await store.load();
    await bot.init();
    botInfo = bot.botInfo;

    // Process updates from different chats concurrently so a slow animation or
    // Gemini call in one chat never freezes the bot for everyone else. Updates
    // within a single chat stay ordered so stats and "last message" stay correct.
    bot.use(
      sequentialize((ctx) => {
        const chatId = ctx.chat?.id;
        return chatId === undefined ? undefined : String(chatId);
      }),
    );

    bot.on('message', (ctx) => handleMessage(deps, ctx.message));
    bot.catch((error) => {
      console.error('Telegram bot error:', error.error);
    });

    started = true;
    runner = run(bot);
    runner.task()?.catch((error) => {
      console.error('Armaturina polling stopped with error:', error);
    });

    console.log('Armaturina bot started.');
  }

  async function stop(): Promise<void> {
    if (!started || !runner) {
      return;
    }

    await runner.stop();
    started = false;
  }

  return {
    start,
    stop,
    bot,
    store,
    get pollingPromise() {
      return runner?.task() ?? null;
    },
  };
}
